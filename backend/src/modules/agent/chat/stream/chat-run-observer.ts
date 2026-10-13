import type {
  AgentExecutionEventSink,
  AgentExecutionMessageObserver,
} from '../../execution/port/agent-executor.js'
import type { ProductStreamEvent } from '../../run/model/agent-run.js'
import type { DisplayMessageCollector } from '../../presentation/service/display-message-collector.js'
import type { SectionCollector } from '../../presentation/service/section-collector.js'
import type { MessageBuffer } from '../../session/message-buffer/port/message-buffer.port.js'
import type { MessageBufferGeneration } from '../../session/message-buffer/port/message-buffer.port.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'

/**
 * 增量写入恢复缓冲的超时（5000ms）。
 * 缓冲是尽力而为的中间态，最终提交点在 Session 保存，所以给一个不长不短的兜底：
 * 卡住超时即放弃本次追加，不让慢缓冲拖住整轮运行。
 */
const BUFFER_TIMEOUT_MILLISECONDS = 5_000

/**
 * 把 Runtime 的事件与消息接回 Chat 用例：事件进入 SSE 队列，消息进入恢复缓冲和展示投影。
 * 该适配器只处理一次运行，不拥有 Session 的最终提交。
 */
export class ChatRunObserver implements AgentExecutionEventSink, AgentExecutionMessageObserver {
  /** 本次运行的 Checkpoint 标识；恢复缓冲与展示投影都以它为键。 */
  readonly #checkpointId: string
  /** 消息缓冲的代数；同一 Checkpoint 下用来隔离不同代次的增量。 */
  readonly #generation: MessageBufferGeneration
  /** 事件分段收集器；把运行时事件累积成展示 section。 */
  readonly #sections: SectionCollector
  /** 展示消息收集器；把已提交消息投影为展示层消息。 */
  readonly #display: DisplayMessageCollector
  /** SSE 事件队列的写入端；事件经它流向前端。 */
  readonly #queue: { push(event: ProductStreamEvent): void }
  /** 恢复缓冲；增量写入尽力而为，最终提交点在 Session 保存。 */
  readonly #messageBuffer: MessageBuffer
  /**
   * 已提交消息的附加观察者（如事实日志写入器）；先于展示投影调用。
   * @param message - 刚被提交的领域消息；观察者须同步消费，不得抛错打断主流程。
   */
  readonly #onMessage: ((message: AgentMessage) => void) | undefined
  /**
   * Runtime 事件的附加观察者（如事实日志写入器）；先于 SSE 投影调用。
   * @param event - Runtime 上报的原始事件；在展示投影改写前交给观察者，且不得抛错。
   */
  readonly #onEvent: ((event: AgentRuntimeEvent) => void) | undefined

  public constructor(options: {
    readonly checkpointId: string
    readonly generation: MessageBufferGeneration
    readonly sections: SectionCollector
    readonly display: DisplayMessageCollector
    readonly queue: { push(event: ProductStreamEvent): void }
    readonly messageBuffer: MessageBuffer
    readonly onMessage?: ((message: AgentMessage) => void) | undefined
    readonly onEvent?: ((event: AgentRuntimeEvent) => void) | undefined
  }) {
    this.#checkpointId = options.checkpointId
    this.#generation = options.generation
    this.#sections = options.sections
    this.#display = options.display
    this.#queue = options.queue
    this.#messageBuffer = options.messageBuffer
    this.#onMessage = options.onMessage
    this.#onEvent = options.onEvent
  }

  /**
   * 事件的三条出路，顺序固定为 **事实日志 → 展示投影 → SSE 队列**。
   * 事实日志放最前：它是审计记录，必须拿到事件的原始形态；
   * 展示投影可能改写或折叠事件，之后再看就不是原貌了。
   *
   * @param event - Runtime 上报的原始事件；本方法按固定顺序把它分发到三条出路，不改写内容。
   */
  public publish(event: AgentRuntimeEvent): void {
    this.#onEvent?.(event)
    this.#sections.collect(event)
    this.#queue.push(event)
  }

  /**
   * 已提交消息的三条出路：事实日志 → 恢复缓冲 → 展示投影。
   *
   * **user 消息不进恢复缓冲**：它来自本次请求的入参，已经在 Session 里了，
   * 再缓冲一份会让崩溃恢复时把它合并成两条。
   * 事实观察放在最前且不设中止检查，是为了让取消路径上已产生的部分消息也留痕。
   *
   * @param message - 刚提交的领域消息；role 决定是否进恢复缓冲，user 消息会被跳过。
   * @param signal - 取消信号，仅约束展示投影；事实观察与恢复缓冲不因它中止。
   */
  public async observe(message: AgentMessage, signal: AbortSignal): Promise<void> {
    // 事实观察先于中止检查：取消路径上已提交的部分消息仍要进入事实日志。
    this.#onMessage?.(message)
    if (message.role !== 'user') await this.#appendBuffer(message)
    await this.#display.collectMessage(this.#checkpointId, message, signal)
  }

  /**
   * 尽力把一条消息增量写入恢复缓冲；超时或失败都只吞掉，不抛出。
   * 缓冲是尽力而为的中间态，最终 Session 保存才是本轮运行的事实提交点。
   * @param message 待增量写入的领域消息；user 消息不会走到这里
   */
  async #appendBuffer(message: AgentMessage): Promise<void> {
    try {
      await this.#messageBuffer.appendGeneration(
        this.#checkpointId,
        this.#generation,
        message,
        AbortSignal.timeout(BUFFER_TIMEOUT_MILLISECONDS)
      )
    } catch {
      // 增量缓冲保持尽力语义，最终 Session 保存仍是本轮运行的事实提交点。
    }
  }
}
