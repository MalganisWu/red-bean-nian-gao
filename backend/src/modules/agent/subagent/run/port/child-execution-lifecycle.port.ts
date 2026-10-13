import type { AgentExecutionOutcome } from '../../../execution/port/agent-executor.js'
import type { StoredRuntimeState } from '../../../execution/model/runtime-state.js'
import type { AgentMessage } from '../../../model/agent-message.js'
import type { AgentJsonValue } from '../../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../../run/model/agent-runtime-event.js'

/** 子执行的业务身份，不向生命周期层暴露 Runtime SDK 上下文。 */
export interface ChildExecutionIdentity {
  /** 子执行标识；生命周期按它定位持久化记录。 */
  readonly executionId: string
  /** 所属父会话标识；结果最终并回这条会话。 */
  readonly sessionId: string
  /** 父请求标识；用于把子执行与发起它的请求串起来。 */
  readonly requestId: string
  /** 触发本次执行的用户；所有权校验依据。 */
  readonly userId: string
  /** 子 Agent 定义标识。 */
  readonly agentId: string
  /** 父会话侧对应的工具调用 id；空串表示非委派场景。 */
  readonly parentCallId: string
  /** 本次执行的会话消息；首条 user 消息作为子 Agent 指令。 */
  readonly messages: readonly AgentMessage[]
  /** 待续跑的中断 id；有值表示这是对 `awaiting_user` 的应答续跑。 */
  readonly interruptId?: string | undefined
}

/** Resume 执行的可续租所有权；失租信号必须传播给 Runtime 与工具调用。 */
export interface ChildExecutionLease {
  /** 租约对应的取消信号；失租时中止，调用方应把它传播给 Runtime 与工具调用。 */
  readonly signal: AbortSignal
  /** 释放租约；无论保存成功或失败都要调用，否则会阻塞后续对同一记录的认领。 */
  release(): void
}

/**
 * Agent Module 的子执行恢复、提交与租约释放边界。
 * 默认实现为 `SubExecutionLifecycle`，由 `RuntimeSubAgentToolFactory` 为每个子 Agent 动态组装；
 * 调用方必须把取消信号传入，并在保存成功或失败后释放取得的 lease。
 */
export interface ChildExecutionLifecycle {
  /**
   * 加载子执行状态：按需创建记录、认领续租、收集待恢复的增量消息。
   * 返回的 lease 由调用方负责释放；拿不到 lease 表示记录被他人占用，本次应放弃。
   *
   * @param identity - 子执行的业务身份，决定加载或创建哪一条记录。
   * @param resume - 是否为续跑；续跑时要认领已有的 `awaiting_user` 记录。
   * @param signal - 取消信号，透传到仓储与租约操作。
   * @returns 可续跑的运行时状态、待恢复消息、持久化版本与本次租约。
   */
  load(
    identity: ChildExecutionIdentity,
    resume: boolean,
    signal: AbortSignal
  ): Promise<{
    readonly state?: StoredRuntimeState | undefined
    readonly recoveryMessages: readonly AgentMessage[]
    readonly persistenceRevision?: bigint | undefined
    readonly lease?: ChildExecutionLease | undefined
  }>
  /**
   * 保存子执行结果：终态写入会连同 buffer 一起收口，并释放本次租约。
   * 保存失败时租约仍需释放，避免记录被永久占用。
   *
   * @param identity - 子执行的业务身份，决定写入哪一条记录。
   * @param outcome - Runtime 执行结果；undefined 视为失败。
   * @param displaySections - 独立展示载荷；缺失时退回用消息序列化。
   * @param executionError - 执行期错误，为失败文案提供兜底。
   * @param persistenceRevision - 加载时拿到的版本号，作为 CAS 基准。
   * @param lease - 本次持有的租约；保存路径负责释放。
   * @param signal - 取消信号，透传到仓储写入。
   */
  save(
    identity: ChildExecutionIdentity,
    outcome: AgentExecutionOutcome | undefined,
    displaySections: AgentJsonValue | undefined,
    executionError: Error | undefined,
    persistenceRevision: bigint | undefined,
    lease: ChildExecutionLease | undefined,
    signal: AbortSignal
  ): Promise<void>
}

/** 子 Runtime 事件 section 的最小收集边界。 */
export interface ChildSectionCollector {
  /**
   * 收集一条子 Runtime 事件；内部按事件类型累积成展示 section。
   *
   * @param event - 子 Agent 运行时事件。
   */
  collect(event: AgentRuntimeEvent): void
  /**
   * 产出累积的 section；在终态写入前调用一次。
   *
   * @returns 可直接落库的展示 section JSON。
   */
  build(): AgentJsonValue
}
