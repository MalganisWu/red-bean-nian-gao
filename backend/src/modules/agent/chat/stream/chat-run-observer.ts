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

const BUFFER_TIMEOUT_MILLISECONDS = 5_000

/**
 * 把 Runtime 的事件与消息接回 Chat 用例：事件进入 SSE 队列，消息进入恢复缓冲和展示投影。
 * 该适配器只处理一次运行，不拥有 Session 的最终提交。
 */
export class ChatRunObserver implements AgentExecutionEventSink, AgentExecutionMessageObserver {
  readonly #checkpointId: string
  readonly #generation: MessageBufferGeneration
  readonly #sections: SectionCollector
  readonly #display: DisplayMessageCollector
  readonly #queue: { push(event: ProductStreamEvent): void }
  readonly #messageBuffer: MessageBuffer
  /** 已提交消息的附加观察者（如事实日志写入器）；先于展示投影调用。 */
  readonly #onMessage: ((message: AgentMessage) => void) | undefined
  /** Runtime 事件的附加观察者（如事实日志写入器）；先于 SSE 投影调用。 */
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

  public publish(event: AgentRuntimeEvent): void {
    this.#onEvent?.(event)
    this.#sections.collect(event)
    this.#queue.push(event)
  }

  public async observe(message: AgentMessage, signal: AbortSignal): Promise<void> {
    // 事实观察先于中止检查：取消路径上已提交的部分消息仍要进入事实日志。
    this.#onMessage?.(message)
    if (message.role !== 'user') await this.#appendBuffer(message)
    await this.#display.collectMessage(this.#checkpointId, message, signal)
  }

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
