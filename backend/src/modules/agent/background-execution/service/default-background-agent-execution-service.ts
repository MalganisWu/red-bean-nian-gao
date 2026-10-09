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

/** 后台运行的统一事件观察器，同时维护崩溃恢复消息与持久展示投影。 */
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

/** Agent Module 的默认后台执行实现；SDK 类型和配置选择不会扩散到 Task Module。 */
export class DefaultBackgroundAgentExecutionService implements BackgroundAgentExecutionPort {
  readonly #loader: AgentLoader
  readonly #executor: AgentExecutionPort
  readonly #buffer: MessageBuffer

  public constructor(loader: AgentLoader, executor: AgentExecutionPort, buffer: MessageBuffer) {
    this.#loader = loader
    this.#executor = executor
    this.#buffer = buffer
  }

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
