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

/**
 * 测试使用的内存消息缓冲实现；复制输入输出，避免调用方共享可变数组所有权。
 *
 * 进出都 `structuredClone`：写入时复制，读出时也复制。只做前者的话，
 * 调用方拿到的数组仍与内部状态同一份，一次就地 `push` 就能绕过 `append` 直接改缓冲区，
 * 测试也就测不出真实实现里的隔离问题。
 */
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

/**
 * 测试使用的内存 Session 仓储；模拟生产实现的用户隔离、revision CAS 与 fencing 语义。
 *
 * 与 Postgres 版本的两处**刻意不同**，改测试时别把它们当成 bug：
 * - **分页游标是 session id，不是时间戳**。内存实现按 `#order` 的插入序维护，
 *   没有可比较的时间轴，用 id 定位更直接。生产实现见 `PostgresSessionRepository`。
 * - `#order` 在每次 `save` 时把该 id 移到末尾，`listByUser` 再 `toReversed()`，
 *   于是「最近更新的排最前」这件事完全不依赖时钟——测试可以注入固定的 `now`。
 */
export class MemorySessionStore implements FencedSessionRepository {
  readonly #sessions = new Map<string, Session>()
  readonly #updated = new Map<string, Date>()
  /** 更新顺序（最早 → 最新）；读取时反转即为列表顺序。 */
  #order: string[] = []
  readonly #now: () => Date

  public constructor(now: () => Date = (): Date => new Date()) {
    this.#now = now
  }

  /** 已存在但不属于该用户 → `NOT_FOUND`（不是「已存在」），与生产实现的所有权隐藏一致。 */
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

  /**
   * CAS + fencing 保存。三道校验只在「已存在」时进行；不存在则视为创建，直接写入。
   *
   * 校验顺序与生产实现一致（越权 → revision → fencing），但这里**先判 revision 再判 fencing**：
   * 内存实现里两者不可能同时不符（都是同一个调用方带来的快照），顺序无实际影响；
   * Postgres 版本因为写进同一条 WHERE，需要事后区分，那里顺序才有意义。
   *
   * 注意 `session.revision` 是**就地自增**的：调用方手上的对象会随之更新，
   * 于是同一次会话里的连续保存可以复用同一个对象。
   */
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
    // 移到末尾 = 最近更新；`listByUser` 反转后即为「最新在前」。
    this.#order = [...this.#order.filter((id): boolean => id !== session.id), session.id]
    return Promise.resolve()
  }

  /** 高水位只前进：`token < current` 报 `STALE_FENCE`，相等与更大都直接写入。`0n` 为无操作。 */
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

/**
 * 取第一条有正文的用户消息作为标题，超过 30 个字符则截断加省略号。
 * 用 `Array.from` 而不是 `slice`：后者按 UTF-16 码元切，会把 emoji 或星形平面的汉字劈成半个。
 * 一条用户消息都没有时返回空串，由展示层决定占位文案。
 */
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
