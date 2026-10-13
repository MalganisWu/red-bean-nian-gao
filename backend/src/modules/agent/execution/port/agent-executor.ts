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

/** 一次执行所需的全部中性依赖；由 Agent Loader 从数据库装配，Runtime 自身不认识数据库。 */
export interface AgentExecutionDefinition {
  /** 模型适配器；已完成厂商绑定，Runtime 只按中性接口调用。 */
  readonly model: AgentModelAdapter
  /** 工具分发器；授权与观测在其外层拼接。 */
  readonly dispatcher: AgentToolDispatcher
  /** 暴露给模型的工具 schema 白名单；空数组表示本次执行不提供工具。 */
  readonly tools: readonly AgentToolSchema[]
  /** 系统提示词，作为每轮对话的固定前缀。 */
  readonly systemPrompt: string
  /** 采样与窗口相关的生成参数。 */
  readonly modelParams: AgentModelParams
  /** 迭代上限、超时与压缩等运行时参数。 */
  readonly runtimeConfig: AgentRuntimeConfig
}

/** 将 Runtime 中性事件交给业务编排层；实现不得反向操作 SDK 状态。 */
export interface AgentExecutionEventSink {
  /**
   * 发布一条 Runtime 中性事件。
   *
   * @param event - 运行事件，已由 Adapter 从 SDK 形态映射为业务中性形态。
   */
  publish(event: AgentRuntimeEvent): void
}

/** 观察 Runtime 已提交消息，供宿主实现增量恢复与展示投影。 */
export interface AgentExecutionMessageObserver {
  /**
   * 观察一条已提交的 Runtime 消息（用户 / 助手 / 工具三种角色共用这一条路径）。
   *
   * @param message - 已提交的消息，已由 Adapter 从 SDK 形态映射为产品形态。
   * @param signal - 取消信号；写入被取消时应尽快中止并抛错。
   */
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

/**
 * 执行命令；`kind` 决定这次是「新开一轮」还是「从挂起处续跑」，
 * 两者对 `state` / `interruptId` / `response` 的要求不同，构造时须与 `kind` 对齐。
 */
export interface AgentExecutionCommand extends AgentRunIdentity {
  /** 命令类型：run 开新轮，resume 从挂起处续跑。 */
  readonly kind: (typeof EXECUTION_COMMAND_KINDS)[keyof typeof EXECUTION_COMMAND_KINDS]
  /** 本次执行所需的中性依赖（模型、工具、提示词与运行时参数）。 */
  readonly definition: AgentExecutionDefinition
  /** 已持久化的 Runtime 快照；缺省表示本次会话尚无快照。 */
  readonly state?: StoredRuntimeState | undefined
  /** 上次崩溃后尚未进入主快照的增量消息，由 Adapter 合并进 SDK 状态。 */
  readonly recoveryMessages?: readonly AgentMessage[] | undefined
  /** 新开一轮的输入消息；kind 为 run 时使用，resume 时忽略。 */
  readonly messages?: readonly AgentMessage[] | undefined
  /** 要回答的挂起 id；kind 为 resume 时必需，用于对回原中断。 */
  readonly interruptId?: string | undefined
  /** 对挂起询问的用户作答；与 `interruptId` 配对，仅在 resume 时有意义。 */
  readonly response?: string | undefined
  /** 运行事件出口；缺省表示本次执行不向外发布事件。 */
  readonly eventSink?: AgentExecutionEventSink | undefined
  /** 已提交消息的观察者；缺省表示本次执行不落库消息。 */
  readonly messageObserver?: AgentExecutionMessageObserver | undefined
}

/** 各状态分支共享的结果底座：输出、消息、状态信封、token 用量与停止原因。 */
interface AgentExecutionOutcomeBase {
  /** 本轮对外输出文本；失败或被取消时可能为空串。 */
  readonly output: string
  /** 运行结束后完整的产品侧消息序列，供上层落库。 */
  readonly messages: readonly AgentMessage[]
  /** 运行结束时的 Runtime 快照信封，供下次续跑。 */
  readonly state: StoredRuntimeState
  /** 本轮累计消耗的 token 数。 */
  readonly tokensUsed: number
  /** 停止原因（SDK 口径，如 stop / length）；失败时作为兜底错误文案。 */
  readonly finishReason: string
}

/** 挂起信息：哪个工具、什么参数，以及供宿主标定这次交互的 id。 */
export interface AgentExecutionInterrupt {
  /** 挂起的工具调用 id；宿主作答时原样带回以定位中断。 */
  readonly id: string
  /** 触发挂起的工具名，供宿主展示与选择作答方式。 */
  readonly toolName: string
  /** 工具原始入参，供宿主渲染确认内容。 */
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
  /**
   * 执行一次 Runtime 运行（开新轮或从此前挂起处续跑）。
   *
   * @param command - 执行命令；`kind` 决定开新轮还是续跑，并决定哪些字段必需。
   * @param signal - 调用方持有的取消信号；中止时 SDK 运行随即关闭。
   * @returns 可辨识联合的执行结果；SDK 失败但留有结果快照时映射为带 error 的失败结果，而非上抛异常。
   */
  execute(command: AgentExecutionCommand, signal: AbortSignal): Promise<AgentExecutionOutcome>
}
