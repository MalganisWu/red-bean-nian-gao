import type { ProductStreamEvent } from '../../run/model/agent-run.js'
import { RunEventQueue } from './run-event-queue.js'

export type ChatRunCloseReason = 'consumer_closed' | 'client_disconnected' | 'server_shutdown'

export type ChatRunResult =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled'; readonly reason: ChatRunCloseReason }
  | { readonly status: 'failed'; readonly error: Error }

/**
 * 一次 Chat 运行的资源句柄。事件消费、后台完成和主动关闭是三个独立生命周期。
 */
export interface ChatRunHandle extends AsyncIterable<ProductStreamEvent> {
  readonly runId: string
  readonly sessionId: string
  readonly events: AsyncIterable<ProductStreamEvent>
  readonly completion: Promise<ChatRunResult>
  close(reason: ChatRunCloseReason): Promise<void>
}

const DEFAULT_EVENT_CAPACITY = 512

/** Agent Run Service 使用的默认句柄；Controller 只依赖上面的公开接口。 */
export class ManagedChatRunHandle implements ChatRunHandle {
  public readonly runId: string
  public readonly sessionId: string
  public readonly events: AsyncIterable<ProductStreamEvent>
  public readonly completion: Promise<ChatRunResult>
  public readonly signal: AbortSignal

  readonly #queue: RunEventQueue<ProductStreamEvent>
  readonly #controller = new AbortController()
  readonly #resolveCompletion: (result: ChatRunResult) => void
  #settled = false
  #closeReason: ChatRunCloseReason | undefined

  public constructor(
    runId: string,
    sessionId: string,
    parentSignal: AbortSignal,
    capacity = DEFAULT_EVENT_CAPACITY
  ) {
    this.runId = runId
    this.sessionId = sessionId
    this.signal = AbortSignal.any([parentSignal, this.#controller.signal])
    this.#queue = new RunEventQueue<ProductStreamEvent>(capacity, (error): void => {
      this.#controller.abort(error)
    })
    this.events = this.#queue
    let resolveCompletion!: (result: ChatRunResult) => void
    this.completion = new Promise<ChatRunResult>((resolve): void => {
      resolveCompletion = resolve
    })
    this.#resolveCompletion = resolveCompletion
  }

  public publish(event: ProductStreamEvent): void {
    this.#queue.push(event)
  }

  public complete(): void {
    if (this.#settled) return
    this.#settled = true
    this.#queue.close()
    this.#resolveCompletion(
      this.#closeReason === undefined
        ? { status: 'completed' }
        : { status: 'cancelled', reason: this.#closeReason }
    )
  }

  public fail(error: Error): void {
    if (this.#settled) return
    this.#settled = true
    this.#queue.fail(error)
    this.#resolveCompletion(
      this.#closeReason === undefined
        ? { status: 'failed', error }
        : { status: 'cancelled', reason: this.#closeReason }
    )
  }

  public async close(reason: ChatRunCloseReason): Promise<void> {
    if (this.#settled) return
    this.#closeReason ??= reason
    this.#controller.abort(new Error(`Chat 运行已取消：${reason}`))
    this.#queue.close()
    // completion 只由生产者在 Session 等收尾完成后结算，停机方可据此安全释放基础设施。
    await this.completion
  }

  public [Symbol.asyncIterator](): AsyncIterator<ProductStreamEvent> {
    return this.events[Symbol.asyncIterator]()
  }
}
