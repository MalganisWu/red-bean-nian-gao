import type { AgentExecutionOutcome } from '../../execution/port/agent-executor.js'
import type {
  AgentInterrupt,
  AgentModelAdapter,
  AgentModelParams,
  AgentRuntimeConfig,
  AgentToolDispatcher,
  AgentToolSchema,
} from '../../execution/model/agent-execution-contract.js'
import type { AgentJsonValue } from '../../model/json-value.js'
import type { AgentBuildConfig } from '../../loader/port/agent-loader.port.js'
import type { CardEvent } from '../model/agent-run.js'

export interface ExecutableAgentConfig extends AgentBuildConfig {
  readonly llmAdapter: AgentModelAdapter
  readonly toolDispatcher: AgentToolDispatcher
  readonly tools: readonly AgentToolSchema[]
  readonly systemPrompt: string
  readonly modelParams: AgentModelParams
  readonly runtimeConfig: AgentRuntimeConfig
}

/** 将 Loader 的可选配置收窄为执行阶段的完整配置。 */
export function executableConfig(config: AgentBuildConfig): ExecutableAgentConfig {
  if (config.llmAdapter === undefined) throw new Error('agent config 缺少 llmAdapter')
  if (config.toolDispatcher === undefined) throw new Error('agent config 缺少 toolDispatcher')
  return {
    ...config,
    llmAdapter: config.llmAdapter,
    toolDispatcher: config.toolDispatcher,
    tools: config.tools ?? [],
    systemPrompt: config.systemPrompt ?? '',
    modelParams: config.modelParams ?? {},
    runtimeConfig: config.runtimeConfig ?? {},
  }
}

export function cardEvent(interrupt: AgentInterrupt): CardEvent {
  const args = interrupt.arguments
  return {
    type: 'card',
    interactionId: interrupt.toolCallId,
    status: 'pending',
    questions: isRecord(args) ? (args['questions'] ?? []) : [],
  }
}

export function executionSignal(
  signal: AbortSignal,
  leaseLost: Promise<Error> | undefined
): AbortSignal {
  if (leaseLost === undefined) return signal
  const controller = new AbortController()
  void leaseLost.then((error): void => controller.abort(error))
  return AbortSignal.any([signal, controller.signal])
}

export function executionError(outcome: AgentExecutionOutcome): Error | undefined {
  switch (outcome.status) {
    case 'completed':
    case 'suspended':
      return undefined
    case 'cancelled':
      return new Error(`Agent 执行已取消：${outcome.reason}`)
    case 'exhausted':
      return new Error('Agent 达到最大工具迭代次数')
    case 'failed':
      return outcome.error
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, AgentJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
