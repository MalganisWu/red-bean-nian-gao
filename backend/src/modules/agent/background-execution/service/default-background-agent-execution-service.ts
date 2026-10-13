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
  /** 恢复缓冲的键；每条已提交消息都与它绑定，供崩溃后重建。 */
  readonly #recoveryKey: string
  /** 事件的分段收集器；把运行时事件累积成面向用户的展示分段。 */
  readonly #sections: SectionCollector
  /** 已产出的展示消息；只收 assistant 且有正文的那些。 */
  readonly #messages: DisplayMessage[]
  /** 恢复缓冲；后台执行唯一的落盘点，写失败即整轮失败。 */
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

  /**
   * 接收 Runtime 上报的事件并喂给分段收集器，累积成给用户看的展示分段；
   * 事件本身不进 SSE 队列——那条路属于 Chat 路径，这里只负责后台运行的展示投影。
   * @param event 运行时上报的事件；按 `step` 归入推理块或工具段
   */
  public publish(event: AgentRuntimeEvent): void {
    this.#sections.collect(event)
  }

  /**
   * 先把消息写进恢复缓冲，再决定要不要投影到展示层。
   * 缓冲写入失败会让本方法抛出、本轮不产生展示消息——宁可少一条展示，也不要恢复记录与展示对不上。
   * 只有 assistant 且正文非空的消息进展示层：user 消息是入参，工具轮次的空正文没有展示价值。
   * @param message 已提交的领域消息；role 与正文决定是否进展示层
   * @param signal 中止信号，透传给恢复缓冲的追加
   */
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
  /** 配置加载器；每次执行读出一次不可变的运行配置快照。 */
  readonly #loader: AgentLoader
  /** 统一执行端口；承载模型、工具与子运行的执行循环。 */
  readonly #executor: AgentExecutionPort
  /** 恢复缓冲；与在线 Chat 路径共用同一 MessageBuffer 实现。 */
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

/**
 * 执行端口所需的**已收窄**配置：把构建配置里的可选字段收敛为必填。
 * `llmAdapter` / `toolDispatcher` 缺失属于装配错误，由 `executableConfig` 提前抛出，不在这里兜底。
 */
interface ExecutableAgentConfig {
  /** LLM 适配器；缺失属装配错误，由 `executableConfig` 提前抛出。 */
  readonly llmAdapter: NonNullable<AgentBuildConfig['llmAdapter']>
  /** 工具分派器；缺失同样视为装配错误。 */
  readonly toolDispatcher: NonNullable<AgentBuildConfig['toolDispatcher']>
  /** 工具 schema 清单；缺省收敛为空数组。 */
  readonly tools: NonNullable<AgentBuildConfig['tools']>
  /** 系统提示词；缺省收敛为空串。 */
  readonly systemPrompt: string
  /** 模型调用参数；缺省收敛为空对象。 */
  readonly modelParams: NonNullable<AgentBuildConfig['modelParams']>
  /** 运行参数；缺省收敛为空对象。 */
  readonly runtimeConfig: NonNullable<AgentBuildConfig['runtimeConfig']>
}

/**
 * 从构建配置中取出后台执行必需的字段并补齐缺省值。
 * 缺 `llmAdapter` / `toolDispatcher` 直接抛错——没有它们无法执行，属于装配错误；
 * 其余可选字段缺省收敛为 `[]` / `''` / `{}`，让执行端口拿到稳定形状。
 * @param config 加载器产出的构建配置，字段可能为可选
 * @returns 字段齐备的执行配置；必填项缺失时抛出
 */
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

/**
 * 把后台执行附带的系统提示词追加到主提示词之后，用空行分隔。
 * 一侧为空时返回另一侧原文，避免拼出只有一个换行的提示词。
 * @param base 主系统提示词，可为空
 * @param appendix 追加片段，可为空
 * @returns 拼好的系统提示词；单侧为空时返回另一侧原文
 */
function appendSystemPrompt(base: string, appendix: string): string {
  if (base === '') return appendix
  if (appendix === '') return base
  return `${base}\n\n${appendix}`
}
