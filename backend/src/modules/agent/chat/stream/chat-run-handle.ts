import type { ProductStreamEvent } from '../../run/model/agent-run.js'
import { RunEventQueue } from './run-event-queue.js'

/** 关闭原因：消费者主动收摊、客户端断连、服务停机排空。 */
export type ChatRunCloseReason = 'consumer_closed' | 'client_disconnected' | 'server_shutdown'

/** 一次运行的结局；`completed` 之外的两种都带原因或错误，供上层决定日志级别与重试。 */
export type ChatRunResult =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled'; readonly reason: ChatRunCloseReason }
  | { readonly status: 'failed'; readonly error: Error }

/**
 * 一次 Chat 运行的资源句柄。事件消费、后台完成和主动关闭是三个独立生命周期。
 */
export interface ChatRunHandle extends AsyncIterable<ProductStreamEvent> {
  /** 本次运行标识，同时也是取消注册表里的 requestId。 */
  readonly runId: string
  /** 该运行归属的会话标识，用于把事件与恢复缓冲写回同一会话。 */
  readonly sessionId: string
  /** 事件消费入口；与 `close`/完成配合，队列 drained 后再发的事件会被静默丢弃。 */
  readonly events: AsyncIterable<ProductStreamEvent>
  /** 运行结局；由生产者在收尾动作全部落地后结算，`close()` 会等待它。 */
  readonly completion: Promise<ChatRunResult>
  /**
   * 主动关闭运行并等待其收尾落地；重复关闭只记首个原因。
   *
   * @param reason - 首个关闭原因；后续重复关闭不会覆盖它。
   */
  close(reason: ChatRunCloseReason): Promise<void>
}

/**
 * 事件队列默认容量（512）。
 * 取这个量级是为了在生产者比消费者快时吸收正常抖动，又不让积压无限增长；
 * 溢出会被当作故障信号转为整次运行失败，而非静默丢帧。
 */
const DEFAULT_EVENT_CAPACITY = 512

/** Agent Run Service 使用的默认句柄；Controller 只依赖上面的公开接口。 */
export class ManagedChatRunHandle implements ChatRunHandle {
  /** 本次运行标识，同时也是取消注册表里的 requestId。 */
  public readonly runId: string
  /** 该运行归属的会话标识，用于把事件与恢复缓冲写回同一会话。 */
  public readonly sessionId: string
  /** 事件消费入口；与 `close`/`fail` 配合，队列 drained 后再发的事件会被静默丢弃。 */
  public readonly events: AsyncIterable<ProductStreamEvent>
  /** 运行结局；由生产者（Run Service）在收尾动作全部落地后结算，`close()` 会等待它。 */
  public readonly completion: Promise<ChatRunResult>
  /** 运行取消信号；合并了父信号与内部控制器，任一侧中止都会触发。 */
  public readonly signal: AbortSignal

  /** 底层事件队列；`events` 直接暴露它的异步迭代能力。 */
  readonly #queue: RunEventQueue<ProductStreamEvent>
  /** 内部中止控制器；与父信号合并成运行取消信号。 */
  readonly #controller = new AbortController()
  /**
   * 结算 `completion` 的回调；由生产者收尾时调用。
   * @param result - 本次运行的最终结局；调用后 `completion` 以它兑现，且不可再次结算。
   */
  readonly #resolveCompletion: (result: ChatRunResult) => void
  /** 是否已结算；置真后 publish/complete/fail/close 都变为安全空操作。 */
  #settled = false
  /** 首个关闭原因；决定最终结局是否报告为 cancelled。 */
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

  /**
   * 向消费端投递一个事件。关闭后调用是安全的空操作（队列已 settled，数据不再外泄）；
   * 队列溢出会被当作故障信号，转为整次运行的失败而不是静默丢帧。
   *
   * 本方法是队列的单生产者入口，不得并发调用。
   *
   * @param event - 待投递的产品事件；调用方须保证顺序，队列不会重排。
   */
  public publish(event: ProductStreamEvent): void {
    this.#queue.push(event)
  }

  /**
   * 正常完成。已关闭过就什么都不做——**关闭优先于完成**：
   * 一旦有人调用 `close`，这次运行对外就该报告为取消，哪怕生产者随后跑完了全部逻辑。
   */
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

  /**
   * 失败收尾；与 `complete` 同样的「关闭优先」规则，结果里带上错误供上层诊断。
   *
   * @param error - 导致运行失败的原始错误；会透传给消费端迭代器并进入 `completion`，不得包装成字符串。
   */
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

  /**
   * 主动关闭：中止运行、关掉事件队列，然后**等 `completion` 兑现**。
   *
   * 最后那个 await 是关键——`completion` 由生产者（`ProductAgentRunService`）在
   * session 保存等收尾动作全部完成后才结算，所以调用方在 `close()` 返回时就能确信
   * 基础设施可以安全释放了。少了它，停机方会在运行还在写库时拆掉连接池。
   *
   * `#closeReason ??= reason` 只记第一个原因：后续的重复关闭（如同时收到断连与停机）
   * 不该覆盖最初那个，否则排障时看到的是一个次生原因。
   *
   * @param reason - 首个关闭原因；后续重复关闭不会覆盖它，最终会成为 `cancelled` 结局的 reason。
   */
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
