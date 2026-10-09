import type { AgentMessage } from '../../../model/agent-message.js'
import type { DisplayMessage } from '../../../presentation/model/display-message.js'
import {
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
  type Session,
  type SessionSummary,
} from '../../model/session.js'
import type { FencedSessionRepository } from '../port/session-repository.port.js'
import type {
  MessageBuffer,
  MessageBufferGeneration,
} from '../../message-buffer/port/message-buffer.port.js'

/** 测试使用的内存消息缓冲实现；复制输入输出，避免调用方共享可变数组所有权。 */
export class MemoryMessageBuffer implements MessageBuffer {
  readonly #messages = new Map<string, AgentMessage[]>()

  public append(sessionId: string, message: AgentMessage, signal: AbortSignal): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const messages = this.#messages.get(sessionId) ?? []
    messages.push(structuredClone(message))
    this.#messages.set(sessionId, messages)
    return Promise.resolve()
  }

  public peek(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    return Promise.resolve(structuredClone(this.#messages.get(sessionId) ?? []))
  }

  public flush(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const messages = structuredClone(this.#messages.get(sessionId) ?? [])
    this.#messages.delete(sessionId)
    return Promise.resolve(messages)
  }

  public clear(sessionId: string, signal: AbortSignal): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    this.#messages.delete(sessionId)
    return Promise.resolve()
  }

  public appendGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.append(generationKey(sessionId, generation), message, signal)
  }

  public peekGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]> {
    return this.peek(generationKey(sessionId, generation), signal)
  }

  public clearGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<void> {
    return this.clear(generationKey(sessionId, generation), signal)
  }
}

function generationKey(sessionId: string, generation: MessageBufferGeneration): string {
  return `${sessionId}:${generation.revision.toString()}`
}

/** 测试使用的内存 Session 仓储；模拟生产实现的用户隔离、revision CAS 与 fencing 语义。 */
export class MemorySessionStore implements FencedSessionRepository {
  readonly #sessions = new Map<string, Session>()
  readonly #updated = new Map<string, Date>()
  #order: string[] = []
  readonly #now: () => Date

  public constructor(now: () => Date = (): Date => new Date()) {
    this.#now = now
  }

  public getOrCreate(sessionId: string, userId: string, signal: AbortSignal): Promise<Session> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined) {
      return existing.userId === userId
        ? Promise.resolve(cloneSession(existing))
        : Promise.reject(notFoundError())
    }
    const session: Session = {
      id: sessionId,
      userId,
      displayMessages: [],
      revision: 0n,
      fencingToken: 0n,
    }
    this.#sessions.set(sessionId, cloneSession(session))
    this.#order.push(sessionId)
    this.#updated.set(sessionId, this.#now())
    return Promise.resolve(cloneSession(session))
  }

  public getById(sessionId: string, userId: string, signal: AbortSignal): Promise<Session> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const session = this.#sessions.get(sessionId)
    if (session === undefined || session.userId !== userId) {
      return Promise.reject(notFoundError())
    }
    return Promise.resolve(cloneSession(session))
  }

  public save(session: Session, signal: AbortSignal): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const current = this.#sessions.get(session.id)
    if (current !== undefined) {
      if (current.userId !== session.userId) return Promise.reject(notFoundError())
      if (current.revision !== session.revision) {
        return Promise.reject(
          new SessionStoreError(
            SESSION_STORE_ERROR_CODES.REVISION_CONFLICT,
            'session revision conflict'
          )
        )
      }
      if (current.fencingToken !== session.fencingToken) {
        return Promise.reject(staleFenceError())
      }
    }

    session.revision += 1n
    this.#sessions.set(session.id, cloneSession(session))
    this.#updated.set(session.id, this.#now())
    this.#order = [...this.#order.filter((id): boolean => id !== session.id), session.id]
    return Promise.resolve()
  }

  public advanceFence(
    sessionId: string,
    userId: string,
    token: bigint,
    signal: AbortSignal
  ): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    if (token === 0n) return Promise.resolve()
    const session = this.#sessions.get(sessionId)
    if (session === undefined || session.userId !== userId) {
      return Promise.reject(notFoundError())
    }
    if (token < session.fencingToken) return Promise.reject(staleFenceError())
    session.fencingToken = token
    return Promise.resolve()
  }

  public listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly SessionSummary[]> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const effectiveLimit = limit <= 0 ? 20 : limit
    const sessions = this.#order
      .toReversed()
      .map((id): Session | undefined => this.#sessions.get(id))
      .filter((session): session is Session => session !== undefined && session.userId === userId)
    const cursorIndex =
      cursor === '' ? -1 : sessions.findIndex((session): boolean => session.id === cursor)
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1
    const summaries: SessionSummary[] = []
    for (const session of sessions.slice(start, start + effectiveLimit)) {
      const updatedAt = this.#updated.get(session.id)
      if (updatedAt === undefined) continue
      summaries.push({
        id: session.id,
        title: extractTitle(session.displayMessages),
        messageCount: session.displayMessages.length,
        updatedAt: new Date(updatedAt),
      })
    }
    return Promise.resolve(summaries)
  }
}

function cloneSession(session: Session): Session {
  return structuredClone(session)
}

function extractTitle(messages: readonly DisplayMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || message.content === undefined) continue
    const characters = Array.from(message.content)
    return characters.length > 30 ? `${characters.slice(0, 30).join('')}...` : message.content
  }
  return ''
}

function notFoundError(): SessionStoreError {
  return new SessionStoreError(SESSION_STORE_ERROR_CODES.NOT_FOUND, 'session not found')
}

function staleFenceError(): SessionStoreError {
  return new SessionStoreError(
    SESSION_STORE_ERROR_CODES.STALE_FENCE,
    'session fencing token is stale'
  )
}

function abortFailure(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('operation aborted', 'AbortError')
}
