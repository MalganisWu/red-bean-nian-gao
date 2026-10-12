import type { StoredRuntimeState } from '../model/runtime-state.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import type { AgentRunIdentity } from '../../run/model/agent-run.js'
import type {
  AgentModelAdapter,
  AgentModelParams,
  AgentRuntimeConfig,
  AgentToolDispatcher,
  AgentToolSchema,
} from '../model/agent-execution-contract.js'

export interface AgentExecutionDefinition {
  readonly model: AgentModelAdapter
  readonly dispatcher: AgentToolDispatcher
  readonly tools: readonly AgentToolSchema[]
  readonly systemPrompt: string
  readonly modelParams: AgentModelParams
  readonly runtimeConfig: AgentRuntimeConfig
}

/** 将 Runtime 中性事件交给业务编排层；实现不得反向操作 SDK 状态。 */
export interface AgentExecutionEventSink {
  publish(event: AgentRuntimeEvent): void
}

/** 观察 Runtime 已提交消息，供宿主实现增量恢复与展示投影。 */
export interface AgentExecutionMessageObserver {
  observe(message: AgentMessage, signal: AbortSignal): Promise<void>
}

/** 执行命令的 kind 成员引用源：比较与构造统一走本常量。 */
export const EXECUTION_COMMAND_KINDS = Object.freeze({
  RUN: 'run',
  RESUME: 'resume',
} as const)

/** Runtime 执行结果状态成员引用源：case 标签与构造统一走本常量。 */
export const EXECUTION_OUTCOME_STATUSES = Object.freeze({
  COMPLETED: 'completed',
  SUSPENDED: 'suspended',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXHAUSTED: 'exhausted',
} as const)

export interface AgentExecutionCommand extends AgentRunIdentity {
  readonly kind: (typeof EXECUTION_COMMAND_KINDS)[keyof typeof EXECUTION_COMMAND_KINDS]
  readonly definition: AgentExecutionDefinition
  readonly state?: StoredRuntimeState | undefined
  /** 上次崩溃后尚未进入主快照的增量消息，由 Adapter 合并进 SDK 状态。 */
  readonly recoveryMessages?: readonly AgentMessage[] | undefined
  readonly messages?: readonly AgentMessage[] | undefined
  readonly interruptId?: string | undefined
  readonly response?: string | undefined
  readonly eventSink?: AgentExecutionEventSink | undefined
  readonly messageObserver?: AgentExecutionMessageObserver | undefined
}

interface AgentExecutionOutcomeBase {
  readonly output: string
  readonly messages: readonly AgentMessage[]
  readonly state: StoredRuntimeState
  readonly tokensUsed: number
  readonly finishReason: string
}

export interface AgentExecutionInterrupt {
  readonly id: string
  readonly toolName: string
  readonly arguments: AgentJsonValue
}

/**
 * Runtime 执行结果使用可辨识联合，避免状态与错误、Interrupt 形成非法组合。
 *
 * `interrupt?: never` / `error?: never` 这些看起来多余的字段是**穷尽性守卫**：
 * 有了它们，`status: 'completed'` 的分支里访问 `outcome.interrupt` 会是编译错误。
 * 这正是这个联合比「一个宽结构 + 可选字段」强的地方——后者允许
 * `{status:'completed', error: ...}` 这种没有意义的组合存在，而消费方无从判断该信哪个。
 */
export type AgentExecutionOutcome =
  | (AgentExecutionOutcomeBase & {
      readonly status: 'completed'
      readonly interrupt?: never
      readonly error?: never
    })
  | (AgentExecutionOutcomeBase & {
      readonly status: 'suspended'
      readonly interrupt: AgentExecutionInterrupt
      readonly error?: never
    })
  | (AgentExecutionOutcomeBase & {
      readonly status: 'cancelled'
      readonly reason: string
      readonly interrupt?: never
      readonly error?: never
    })
  | (AgentExecutionOutcomeBase & {
      readonly status: 'exhausted'
      readonly usage: { readonly tokensUsed: number }
      readonly interrupt?: never
      readonly error?: never
    })
  | (AgentExecutionOutcomeBase & {
      readonly status: 'failed'
      readonly error: Error
      readonly interrupt?: never
    })

/**
 * Agent Module 拥有的单次 Runtime 执行边界，供普通对话、后台任务与 Sub-Agent 共同调用。
 * 默认实现为 `RuntimeAgentExecutor`，由 `agent.module.ts` 的 `createAgentModuleCore()` 创建；
 * `app/composition-root.ts` 调用该工厂并注入平台 Tracer、LLM 与 Tool 能力。
 * Adapter 独占业务 DTO 与 Runtime SDK DTO 的转换，并为每次调用创建、关闭 SDK Runtime；调用方拥有
 * `AbortSignal`，产品 Session 持久化、lease 与 finalization 仍由各自业务生命周期负责。
 */
export interface AgentExecutionPort {
  execute(command: AgentExecutionCommand, signal: AbortSignal): Promise<AgentExecutionOutcome>
}
