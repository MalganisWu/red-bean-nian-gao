import type {
  AgentExecutionCommand,
  AgentExecutionDefinition,
  AgentExecutionEventSink,
  AgentExecutionMessageObserver,
  AgentExecutionPort,
} from '../../execution/port/agent-executor.js'
import {
  EXECUTION_COMMAND_KINDS,
  EXECUTION_OUTCOME_STATUSES,
} from '../../execution/port/agent-executor.js'
import type { AgentBuildConfig, AgentLoader } from '../../loader/port/agent-loader.port.js'
import type { DisplayMessage } from '../../presentation/model/display-message.js'
import { SectionCollector } from '../../presentation/service/section-collector.js'
import type { MessageBuffer } from '../../session/message-buffer/port/message-buffer.port.js'
import type {
  BackgroundAgentExecutionCommand,
  BackgroundAgentExecutionPort,
  BackgroundAgentExecutionResult,
} from '../port/background-agent-execution.port.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'

/**
 * 后台运行的统一事件观察器，同时维护崩溃恢复消息与持久展示投影。
 *
 * 这是后台执行**唯一**的落盘点：先把消息写进恢复缓冲，再决定要不要投影到展示层。
 * 顺序不能反——缓冲是崩溃恢复的事实来源，投影只是给人看的视图；
 * 写缓冲失败时整个 `observe` 抛出，本轮不产生展示消息，宁可少一条展示也不要一份对不上的恢复记录。
 *
 * 只有 assistant 且有正文的消息进展示层：user 消息是入参（调用方本来就有），
 * 工具轮次的空正文没有展示价值。
 */
class BackgroundRunObserver implements AgentExecutionEventSink, AgentExecutionMessageObserver {
  readonly #recoveryKey: string
  readonly #sections: SectionCollector
  readonly #messages: DisplayMessage[]
  readonly #buffer: MessageBuffer

  public constructor(
    recoveryKey: string,
    sections: SectionCollector,
    messages: DisplayMessage[],
    buffer: MessageBuffer
  ) {
    this.#recoveryKey = recoveryKey
    this.#sections = sections
    this.#messages = messages
    this.#buffer = buffer
  }

  public publish(event: AgentRuntimeEvent): void {
    this.#sections.collect(event)
  }

  public async observe(message: AgentMessage, signal: AbortSignal): Promise<void> {
    await this.#buffer.append(this.#recoveryKey, message, signal)
    if (message.role !== 'assistant' || message.content === null || message.content === '') return
    const timestamp = Date.now()
    this.#messages.push({
      role: 'assistant',
      content: message.content,
      sections: this.#sections.build(),
      timestamp,
    })
  }
}

/**
 * Agent Module 的默认后台执行实现；SDK 类型和配置选择不会扩散到 Task Module。
 *
 * 与聊天主路径的两处差异来自「没有在线消费者」这个前提：
 * - 工具清单可以被**按名排除**（`excludedToolNames`），因为定时任务不该拥有交互式工具；
 * - 系统提示词可以**追加**一段，用来告诉 Agent 当前是无人值守的后台执行。
 */
export class DefaultBackgroundAgentExecutionService implements BackgroundAgentExecutionPort {
  readonly #loader: AgentLoader
  readonly #executor: AgentExecutionPort
  readonly #buffer: MessageBuffer

  public constructor(loader: AgentLoader, executor: AgentExecutionPort, buffer: MessageBuffer) {
    this.#loader = loader
    this.#executor = executor
    this.#buffer = buffer
  }

  /**
   * 跑一次后台执行：加载配置、按名排除交互式工具、追加系统提示词，经统一执行端口跑完并投影结果。
   * 没有在线消费者，因此中断（suspended）在结果里表达为「等待用户输入」而不是让调用方去处理卡片。
   * @param command 后台执行命令，承载身份、输入、排除工具名与系统提示词附录
   * @param signal 中止信号，透传给 Loader 与执行端口
   * @returns 后台执行结果；按执行端口状态映射为 completed / suspended / cancelled / exhausted / failed
   */
  public async execute(
    command: BackgroundAgentExecutionCommand,
    signal: AbortSignal
  ): Promise<BackgroundAgentExecutionResult> {
    const config = executableConfig(await this.#loader.load(command.agentId, signal))
    const sections = new SectionCollector()
    const displayMessages: DisplayMessage[] = []
    const observer = new BackgroundRunObserver(
      command.recoveryKey,
      sections,
      displayMessages,
      this.#buffer
    )
    const definition: AgentExecutionDefinition = {
      model: config.llmAdapter,
      dispatcher: config.toolDispatcher,
      tools: config.tools.filter(
        (tool): boolean => !command.excludedToolNames.includes(tool.function.name)
      ),
      systemPrompt: appendSystemPrompt(config.systemPrompt, command.systemPromptAppendix),
      modelParams: config.modelParams,
      runtimeConfig: config.runtimeConfig,
    }
    const executionCommand: AgentExecutionCommand = {
      kind: EXECUTION_COMMAND_KINDS.RUN,
      runId: command.runId,
      sessionId: command.sessionId,
      userId: command.userId,
      traceId: command.traceId,
      definition,
      messages: command.input === '' ? [] : [{ role: 'user', content: command.input }],
      eventSink: observer,
      messageObserver: observer,
    }
    const outcome = await this.#executor.execute(executionCommand, signal)
    const base = {
      output: outcome.output,
      displayMessages,
    }
    switch (outcome.status) {
      case EXECUTION_OUTCOME_STATUSES.COMPLETED:
        return { ...base, status: EXECUTION_OUTCOME_STATUSES.COMPLETED }
      case EXECUTION_OUTCOME_STATUSES.SUSPENDED:
        return {
          ...base,
          status: EXECUTION_OUTCOME_STATUSES.SUSPENDED,
          reason: '后台 Agent 等待用户输入',
        }
      case EXECUTION_OUTCOME_STATUSES.CANCELLED:
        return { ...base, status: EXECUTION_OUTCOME_STATUSES.CANCELLED, reason: outcome.reason }
      case EXECUTION_OUTCOME_STATUSES.EXHAUSTED:
        return {
          ...base,
          status: EXECUTION_OUTCOME_STATUSES.EXHAUSTED,
          reason: '后台 Agent 达到最大迭代次数',
        }
      case EXECUTION_OUTCOME_STATUSES.FAILED:
        return { ...base, status: EXECUTION_OUTCOME_STATUSES.FAILED, error: outcome.error }
    }
  }

  /**
   * 清空恢复缓冲。先 `flush` 再 `clear` 而不是直接 `clear`：
   * 凭 `flush` 的「读取并删除」语义确认残留内容确实被取走并丢弃，
   * 随后 `clear` 兜底处理两步之间新写入的消息。两次调用都是幂等的。
   * @param recoveryKey 恢复缓冲的键（通常由会话与任务派生）
   * @param signal 中止信号，传给 MessageBuffer 的 flush / clear
   */
  public async clearRecovery(recoveryKey: string, signal: AbortSignal): Promise<void> {
    await this.#buffer.flush(recoveryKey, signal)
    await this.#buffer.clear(recoveryKey, signal)
  }
}

interface ExecutableAgentConfig {
  readonly llmAdapter: NonNullable<AgentBuildConfig['llmAdapter']>
  readonly toolDispatcher: NonNullable<AgentBuildConfig['toolDispatcher']>
  readonly tools: NonNullable<AgentBuildConfig['tools']>
  readonly systemPrompt: string
  readonly modelParams: NonNullable<AgentBuildConfig['modelParams']>
  readonly runtimeConfig: NonNullable<AgentBuildConfig['runtimeConfig']>
}

function executableConfig(config: AgentBuildConfig): ExecutableAgentConfig {
  if (config.llmAdapter === undefined) throw new Error('后台 Agent 配置缺少 llmAdapter')
  if (config.toolDispatcher === undefined) throw new Error('后台 Agent 配置缺少 toolDispatcher')
  return {
    llmAdapter: config.llmAdapter,
    toolDispatcher: config.toolDispatcher,
    tools: config.tools ?? [],
    systemPrompt: config.systemPrompt ?? '',
    modelParams: config.modelParams ?? {},
    runtimeConfig: config.runtimeConfig ?? {},
  }
}

function appendSystemPrompt(base: string, appendix: string): string {
  if (base === '') return appendix
  if (appendix === '') return base
  return `${base}\n\n${appendix}`
}
