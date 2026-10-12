import type { AgentMessage } from '../../../model/agent-message.js'
import type { DisplayMessage } from '../../../presentation/model/display-message.js'
import type { StoredRuntimeState } from '../../../execution/model/runtime-state.js'
import type { AnswerMarker } from '../../model/session.js'
import type { SessionLease } from '../../lock/port/session-lock.js'
import type { AgentRunIdentity } from '../../../run/model/agent-run.js'

/** 加载请求；带 `answer` 表示这次加载是为一次续跑（用户已对卡片作答）。 */
export interface SessionLoadRequest extends AgentRunIdentity {
  readonly checkpointId: string
  readonly messages: readonly AgentMessage[]
  readonly answer?: AnswerMarker
}

/** 加载后的完整运行态；`lock` 是本次持有的租约（由 `save` 负责释放），`leaseLost` 是失租信号。 */
export interface SessionRunState extends AgentRunIdentity {
  readonly checkpointId: string
  readonly messages: readonly AgentMessage[]
  readonly answer?: AnswerMarker
  readonly resume?: { readonly interruptId: string; readonly response: string } | undefined
  readonly checkpointRevision: bigint
  readonly fencingToken: bigint
  readonly bufferWriteProof?: string | undefined
  readonly runtimeState: StoredRuntimeState | undefined
  readonly recoveryMessages: readonly AgentMessage[]
  readonly displayMessages: readonly DisplayMessage[]
  readonly leaseLost?: Promise<Error> | undefined
  readonly lock?: SessionLease | undefined
}

/** 一次运行的结果；`interruptCallId` 有值表示本轮流停在某个挂起的工具调用上。 */
export interface SessionRunOutcome {
  readonly runtimeState?: StoredRuntimeState | undefined
  readonly displayMessages: readonly DisplayMessage[]
  readonly executionError?: Error
  readonly interruptCallId?: string
}

/**
 * 一次 Agent 回合的会话加载与保存边界。
 * 默认实现为 SessionLifecycle，由 agent.module.ts 组装；save 总是负责释放本轮 lease。
 */
export interface SessionRunServicePort {
  load(request: SessionLoadRequest, signal: AbortSignal): Promise<SessionRunState>
  save(state: SessionRunState, outcome: SessionRunOutcome, signal: AbortSignal): Promise<void>
}
