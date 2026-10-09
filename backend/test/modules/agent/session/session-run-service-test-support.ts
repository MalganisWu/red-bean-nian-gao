import type { RawMessage } from 'red-bean-qing-tuan/pipeline'
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
} from '../../../../src/modules/agent/session/lock/port/session-lock.js'
import { MemoryMessageBuffer } from '../../../../src/modules/agent/session/repository/adapter/memory-session-repository.js'
import {
  SessionStoreError,
  type AnswerMarker,
  type Session,
} from '../../../../src/modules/agent/session/model/session.js'
import { runtimeState } from '../../../helpers/runtime-state.js'
import type { AgentMessage } from '../../../../src/modules/agent/model/agent-message.js'
import type { MessageBuffer } from '../../../../src/modules/agent/session/message-buffer/port/message-buffer.port.js'
import type { MessageBufferGeneration } from '../../../../src/modules/agent/session/message-buffer/port/message-buffer.port.js'

export const SIGNAL = new AbortController().signal

export class TestLock {
  public readonly fencingToken: bigint
  public readonly writeProof: string
  public readonly lost: Promise<Error>
  public releases = 0
  readonly #resolveLost: (error: Error) => void

  public constructor(fencingToken: bigint = 7n) {
    this.fencingToken = fencingToken
    this.writeProof = `owner-${fencingToken.toString()}`
    let resolveLost!: (error: Error) => void
    this.lost = new Promise<Error>((resolve): void => {
      resolveLost = resolve
    })
    this.#resolveLost = resolveLost
  }

  public release(): void {
    this.releases += 1
  }

  public lose(error: Error): void {
    this.#resolveLost(error)
  }
}

export class TestLockRegistry {
  public readonly lock: TestLock
  public conflict = false

  public constructor(fencingToken = 7n) {
    this.lock = new TestLock(fencingToken)
  }

  public tryAcquire(): Promise<TestLock> {
    if (this.conflict) {
      return Promise.reject(new RegistryError(REGISTRY_ERROR_CODES.LOCK_CONFLICT))
    }
    return Promise.resolve(this.lock)
  }
}

export class FailingGenerationClearBuffer implements MessageBuffer {
  readonly #delegate = new MemoryMessageBuffer()
  public failGenerationClear = true

  public append(key: string, message: AgentMessage, signal: AbortSignal): Promise<void> {
    return this.#delegate.append(key, message, signal)
  }

  public peek(key: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    return this.#delegate.peek(key, signal)
  }

  public flush(key: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    return this.#delegate.flush(key, signal)
  }

  public clear(key: string, signal: AbortSignal): Promise<void> {
    return this.#delegate.clear(key, signal)
  }

  public appendGeneration(
    key: string,
    generation: MessageBufferGeneration,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.#delegate.appendGeneration(key, generation, message, signal)
  }

  public peekGeneration(
    key: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]> {
    return this.#delegate.peekGeneration(key, generation, signal)
  }

  public clearGeneration(
    key: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<void> {
    if (this.failGenerationClear) return Promise.reject(new Error('injected clear failure'))
    return this.#delegate.clearGeneration(key, generation, signal)
  }
}

export class FailingAppendBuffer extends MemoryMessageBuffer {
  public override appendGeneration(): Promise<void> {
    return Promise.reject(new Error('injected append failure'))
  }
}

export function request(messages: readonly RawMessage[]): {
  sessionId: string
  checkpointId: string
  userId: string
  runId: string
  traceId: string
  messages: readonly RawMessage[]
} {
  return {
    sessionId: 'session-1',
    checkpointId: 'session-1',
    userId: 'user-1',
    runId: 'request-1',
    traceId: 'trace-1',
    messages,
  }
}

export function generation(revision: bigint, writeProof?: string): MessageBufferGeneration {
  return { revision, ...(writeProof === undefined ? {} : { writeProof }) }
}

export function answerMarker(): AnswerMarker {
  return {
    interactionId: 'call_ask',
    answers: { q1: { kind: 'option', value: '是' } },
    refused: false,
  }
}

export function sessionWithCard(status: string): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    runtimeState: runtimeState([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_ask',
            type: 'function',
            function: { name: 'sys_ask_user', arguments: '{}' },
          },
        ],
      },
    ]),
    displayMessages: [
      {
        role: 'assistant',
        sections: [
          { type: 'reason', items: [{ content: '提问思考' }], timestamp: 1 },
          {
            type: 'card',
            card: {
              interaction_id: 'call_ask',
              status,
              questions: [{ id: 'q1', text: '确认？', options: ['是', '否'] }],
            },
            timestamp: 2,
          },
        ],
        timestamp: 1,
      },
    ],
    revision: 0n,
    fencingToken: 0n,
  }
}

export function isSessionError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof SessionStoreError && error.code === code
}
