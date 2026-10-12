import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import type {
  AgentExecutionEventSink,
  AgentExecutionMessageObserver,
} from '../../execution/port/agent-executor.js'
import type { ChildSectionCollector } from '../run/port/child-execution-lifecycle.port.js'

/** 增量消息落库的回调；带上 `persistenceRevision` 是为了让这次写入也参与 CAS。 */
export type ChildMessageSink = (
  executionId: string,
  persistenceRevision: bigint,
  message: AgentMessage,
  signal: AbortSignal
) => Promise<void>

/** 造子运行事件出口的工厂；返回的 sink 会同时喂给子执行的展示收集器与父流。 */
export type ChildStreamFactory = (
  executionId: string,
  parentCallId: string,
  parentEventSink: ((event: AgentRuntimeEvent) => void) | undefined
) => (event: AgentRuntimeEvent) => void

/** 把子 Agent 的中性输出同时交给展示收集器、父流与增量消息缓冲。 */
export class ChildExecutionObserver
  implements AgentExecutionEventSink, AgentExecutionMessageObserver
{
  readonly #executionId: string
  readonly #persistenceRevision: bigint
  readonly #sections: ChildSectionCollector | undefined
  readonly #eventSink: ((event: AgentRuntimeEvent) => void) | undefined
  readonly #messageSink: ChildMessageSink | undefined

  public constructor(
    executionId: string,
    persistenceRevision: bigint,
    sections: ChildSectionCollector | undefined,
    eventSink: ((event: AgentRuntimeEvent) => void) | undefined,
    messageSink: ChildMessageSink | undefined
  ) {
    this.#executionId = executionId
    this.#persistenceRevision = persistenceRevision
    this.#sections = sections
    this.#eventSink = eventSink
    this.#messageSink = messageSink
  }

  /**
   * 事件同时进两处：子执行自己的展示收集器（落进它的执行记录），
   * 以及父流的事件出口（让父运行的 SSE 能把子执行的进展折叠展示出来）。
   * 三者都可选，因此观察器的存在不会强制宿主提供任何一项能力。
   */
  public publish(event: AgentRuntimeEvent): void {
    this.#sections?.collect(event)
    this.#eventSink?.(event)
  }

  public observe(message: AgentMessage, signal: AbortSignal): Promise<void> {
    return (
      this.#messageSink?.(this.#executionId, this.#persistenceRevision, message, signal) ??
      Promise.resolve()
    )
  }
}
