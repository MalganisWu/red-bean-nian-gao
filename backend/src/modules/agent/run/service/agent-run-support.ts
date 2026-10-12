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

/** 执行阶段必需的完整配置：把 `AgentBuildConfig` 的可选字段收窄为必填。 */
export interface ExecutableAgentConfig extends AgentBuildConfig {
  readonly llmAdapter: AgentModelAdapter
  readonly toolDispatcher: AgentToolDispatcher
  readonly tools: readonly AgentToolSchema[]
  readonly systemPrompt: string
  readonly modelParams: AgentModelParams
  readonly runtimeConfig: AgentRuntimeConfig
}

/**
 * 将 Loader 的可选配置收窄为执行阶段的完整配置。
 * Loader 的返回类型把 `llmAdapter` / `toolDispatcher` 标为可选（它要兼容「只查配置不执行」的调用方），
 * 而执行阶段二者缺一不可，所以在进入执行前显式收窄一次：缺了就当场报错，
 * 而不是等到 Runtime 深处抛一个看不出源头的错。
 */
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

/**
 * 把中断投影成待确认的交互卡片。
 * `questions` 从工具参数里取；参数不是对象或没有该字段时用空数组兜底——
 * 卡片结构必须始终合法，展示层不该为了一个缺字段去判空。
 */
export function cardEvent(interrupt: AgentInterrupt): CardEvent {
  const args = interrupt.arguments
  return {
    type: 'card',
    interactionId: interrupt.toolCallId,
    status: 'pending',
    questions: isRecord(args) ? (args['questions'] ?? []) : [],
  }
}

/**
 * 把「运行取消」与「会话锁丢失」合成一个执行信号。
 *
 * 锁丢失必须以**取消**的形式让 Runtime 停下来：此时另一个实例已经接管了这个会话，
 * 本实例再继续跑就是在写一份会被覆盖的状态。用 `AbortSignal.any` 合流而不是替换信号，
 * 两种中止原因都能保留各自的 `reason`。
 */
export function executionSignal(
  signal: AbortSignal,
  leaseLost: Promise<Error> | undefined
): AbortSignal {
  if (leaseLost === undefined) return signal
  const controller = new AbortController()
  void leaseLost.then((error): void => controller.abort(error))
  return AbortSignal.any([signal, controller.signal])
}

/**
 * 把执行结果映射成「这次算不算失败」的错误。
 *
 * `completed` 与 **`suspended` 都不算失败**——挂起是等待用户确认的正常中间态，
 * 把它当错误会让每一次审批都变成一次告警。其余三态各自保留原因而不是统一成「执行失败」，
 * 因为轨迹视图要能区分它们。
 */
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
