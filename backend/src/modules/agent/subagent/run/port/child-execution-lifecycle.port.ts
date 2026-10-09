import type { AgentExecutionOutcome } from '../../../execution/port/agent-executor.js'
import type { StoredRuntimeState } from '../../../execution/model/runtime-state.js'
import type { AgentMessage } from '../../../model/agent-message.js'
import type { AgentJsonValue } from '../../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../../run/model/agent-runtime-event.js'

/** 子执行的业务身份，不向生命周期层暴露 Runtime SDK 上下文。 */
export interface ChildExecutionIdentity {
  readonly executionId: string
  readonly sessionId: string
  readonly requestId: string
  readonly userId: string
  readonly agentId: string
  readonly parentCallId: string
  readonly messages: readonly AgentMessage[]
  readonly interruptId?: string | undefined
}

/** Resume 执行的可续租所有权；失租信号必须传播给 Runtime 与工具调用。 */
export interface ChildExecutionLease {
  readonly signal: AbortSignal
  release(): void
}

/**
 * Agent Module 的子执行恢复、提交与租约释放边界。
 * 默认实现为 `SubExecutionLifecycle`，由 `RuntimeSubAgentToolFactory` 为每个子 Agent 动态组装；
 * 调用方必须把取消信号传入，并在保存成功或失败后释放取得的 lease。
 */
export interface ChildExecutionLifecycle {
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
  collect(event: AgentRuntimeEvent): void
  build(): AgentJsonValue
}
