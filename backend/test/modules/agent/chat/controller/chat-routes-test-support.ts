import type { IdGenerator } from '../../../../../src/shared/id/id-generator.js'
import type { AgentRunServicePort } from '../../../../../src/modules/agent/run/port/agent-run-service.port.js'
import type { CancelRegistryPort } from '../../../../../src/modules/agent/cancellation/port/cancellation-registry.port.js'
import type { AuthServicePort } from '../../../../../src/modules/identity/service/authentication/port/auth-service.port.js'
import type {
  AgentRunRequest,
  ProductStreamEvent,
} from '../../../../../src/modules/agent/run/model/agent-run.js'
import {
  ManagedChatRunHandle,
  type ChatRunHandle,
} from '../../../../../src/modules/agent/chat/stream/chat-run-handle.js'
import type { ChatUseCasePort } from '../../../../../src/modules/agent/chat/port/chat-use-case.port.js'
import type {
  StartChatCommand,
  StartedChatRun,
} from '../../../../../src/modules/agent/chat/model/chat-command.js'

export /** 固定测试中的运行与会话 ID，便于直接断言 SSE 首帧。 */
class SequentialIds implements IdGenerator {
  #next = 0
  public generate(prefix: string): string {
    this.#next += 1
    return `${prefix}_${String(this.#next)}`
  }
}

export class TestAuth implements AuthServicePort {
  public login(): Promise<string> {
    return Promise.resolve('token')
  }
  public logout(): Promise<void> {
    return Promise.resolve()
  }
  public validateToken(): Promise<string> {
    return Promise.resolve('USER_1')
  }
  public refreshToken(): Promise<string> {
    return Promise.resolve('token')
  }
}

export class TestCancelRegistry implements CancelRegistryPort {
  public wrappedKey = ''
  public cancelledKey = ''
  public deregisteredKey = ''

  public wrap(parent: AbortSignal, key: string): AbortSignal {
    this.wrappedKey = key
    return parent
  }
  public cancel(key: string): boolean {
    this.cancelledKey = key
    return true
  }
  public deregister(key: string): void {
    this.deregisteredKey = key
  }
}

export class CapturingRunService implements AgentRunServicePort {
  public request: AgentRunRequest | undefined
  public events: readonly ProductStreamEvent[] = [
    { type: 'token', content: 'ok' },
    { type: 'done', tokensUsed: 3, sessionId: 'SESSION_1' },
  ]

  public start(request: AgentRunRequest): ChatRunHandle {
    this.request = request
    return testHandle(this.events)
  }
}

export class DisconnectCapturingChat implements ChatUseCasePort {
  public command: StartChatCommand | undefined
  public closeReason = ''
  readonly #closed = deferred()

  public start(command: StartChatCommand): Promise<StartedChatRun> {
    this.command = command
    const events: AsyncIterable<ProductStreamEvent> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProductStreamEvent> {
        yield* []
        await new Promise<void>(() => {})
      },
    }
    const handle: ChatRunHandle = {
      runId: 'RUN_SOCKET',
      sessionId: 'SESSION_SOCKET',
      events,
      completion: this.#closed.promise.then(() => ({
        status: 'cancelled' as const,
        reason: 'client_disconnected' as const,
      })),
      close: (reason): Promise<void> => {
        this.closeReason = reason
        this.#closed.resolve()
        return Promise.resolve()
      },
      [Symbol.asyncIterator](): AsyncIterator<ProductStreamEvent> {
        return events[Symbol.asyncIterator]()
      },
    }
    return Promise.resolve({
      start: {
        type: 'start',
        requestId: handle.runId,
        sessionId: handle.sessionId,
        traceId: command.traceId,
      },
      handle,
    })
  }

  public answer(): Promise<StartedChatRun> {
    return Promise.reject(new Error('unused'))
  }

  public cancel(): Promise<void> {
    return Promise.resolve()
  }

  public waitUntilClosed(): Promise<void> {
    return this.#closed.promise
  }
}

export class SlowConsumerChat implements ChatUseCasePort {
  public handle: ManagedChatRunHandle | undefined

  public start(command: StartChatCommand): Promise<StartedChatRun> {
    const handle = new ManagedChatRunHandle('RUN_SLOW', 'SESSION_SLOW', command.signal, 8)
    this.handle = handle
    setImmediate((): void => {
      for (let index = 0; index < 32; index += 1) {
        handle.publish({ type: 'token', content: 'x'.repeat(64 * 1_024) })
      }
      if (handle.signal.aborted) {
        handle.fail(new Error('slow consumer cancelled'))
      }
    })
    return Promise.resolve({
      start: {
        type: 'start',
        requestId: handle.runId,
        sessionId: handle.sessionId,
        traceId: command.traceId,
      },
      handle,
    })
  }

  public answer(): Promise<StartedChatRun> {
    return Promise.reject(new Error('unused'))
  }

  public cancel(): Promise<void> {
    return Promise.resolve()
  }
}

export function testHandle(
  events: AsyncIterable<ProductStreamEvent> | readonly ProductStreamEvent[]
): ChatRunHandle {
  const stream: AsyncIterable<ProductStreamEvent> =
    Symbol.asyncIterator in events
      ? events
      : {
          async *[Symbol.asyncIterator](): AsyncGenerator<ProductStreamEvent> {
            await Promise.resolve()
            for (const event of events) yield event
          },
        }
  return {
    runId: 'RUN_1',
    sessionId: 'SESSION_1',
    events: stream,
    completion: Promise.resolve({ status: 'completed' }),
    close: (): Promise<void> => Promise.resolve(),
    [Symbol.asyncIterator](): AsyncIterator<ProductStreamEvent> {
      return stream[Symbol.asyncIterator]()
    },
  }
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new Error('deferred promise resolved before initialization')
  }
  const promise = new Promise<void>((resolvePromise): void => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve): void => {
    signal.addEventListener('abort', (): void => resolve(), { once: true })
  })
}
