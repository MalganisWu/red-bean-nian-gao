import type { AgentMessage } from '../../../model/agent-message.js'
import type { DisplayMessage } from '../../../presentation/model/display-message.js'
import type { StoredRuntimeState } from '../../../execution/model/runtime-state.js'
import type { AnswerMarker } from '../../model/session.js'
import type { SessionLease } from '../../lock/port/session-lock.js'
import type { AgentRunIdentity } from '../../../run/model/agent-run.js'

/** 加载请求；带 `answer` 表示这次加载是为一次续跑（用户已对卡片作答）。 */
export interface SessionLoadRequest extends AgentRunIdentity {
  /** 恢复起点 checkpoint 标识；为空表示全新会话，从空历史起步。 */
  readonly checkpointId: string
  /** 已提交进 checkpoint 的历史消息；与缓冲里的增量消息拼接后再交给运行。 */
  readonly messages: readonly AgentMessage[]
  /** 卡片作答标记；有值表示本次是续跑，load 时据此补上悬空工具的结果。 */
  readonly answer?: AnswerMarker
}

/** 加载后的完整运行态；`lock` 是本次持有的租约（由 `save` 负责释放），`leaseLost` 是失租信号。 */
export interface SessionRunState extends AgentRunIdentity {
  /** 本次运行对应的 checkpoint 标识；保存时作为写入目标。 */
  readonly checkpointId: string
  /** 拼接后交给模型的完整消息历史，含 checkpoint 与缓冲增量。 */
  readonly messages: readonly AgentMessage[]
  /** 卡片作答标记；续跑场景下带回，用于校验会话不变量。 */
  readonly answer?: AnswerMarker
  /** 续跑指令；interruptId 指向悬空的工具调用，response 是补回的作答文本。 */
  readonly resume?: { readonly interruptId: string; readonly response: string } | undefined
  /** checkpoint 的持久化版本号；CAS 保存时作为比较基准，防止覆盖并发写。 */
  readonly checkpointRevision: bigint
  /** 会话锁的 fencing 令牌；保存时原样带回，令牌陈旧即拒绝写入。 */
  readonly fencingToken: bigint
  /** 缓冲写入所有权证明；分代清理时据此拒绝已失租 owner 的写入。 */
  readonly bufferWriteProof?: string | undefined
  /** 上一轮留下的运行时状态；缺省表示无 checkpoint 可续。 */
  readonly runtimeState: StoredRuntimeState | undefined
  /** 从缓冲恢复出的增量消息；已并入 `messages`，单独保留供保存时对账清理。 */
  readonly recoveryMessages: readonly AgentMessage[]
  /** 面向展示的消息；保存时整体回写，是展示层的唯一事实来源。 */
  readonly displayMessages: readonly DisplayMessage[]
  /** 失租信号；运行期间续租失败时兑现，调用方据此中止后续写入。 */
  readonly leaseLost?: Promise<Error> | undefined
  /** 本次持有的租约；由 `save` 负责释放，调用方不要自行释放以免重复。 */
  readonly lock?: SessionLease | undefined
}

/** 一次运行的结果；`interruptCallId` 有值表示本轮流停在某个挂起的工具调用上。 */
export interface SessionRunOutcome {
  /** 本轮结束时的运行时状态；缺省表示运行未产生新的 checkpoint。 */
  readonly runtimeState?: StoredRuntimeState | undefined
  /** 本轮新增的展示消息；保存时与既有历史合并后回写。 */
  readonly displayMessages: readonly DisplayMessage[]
  /** 本轮运行抛出的错误；有值时仍要保存已产生的历史，避免丢弃进度。 */
  readonly executionError?: Error
  /** 本轮流停的挂起工具调用 id；有值表示要等用户作答后续跑。 */
  readonly interruptCallId?: string
}

/**
 * 一次 Agent 回合的会话加载与保存边界。
 * 默认实现为 SessionLifecycle，由 agent.module.ts 组装；save 总是负责释放本轮 lease。
 */
export interface SessionRunServicePort {
  /**
   * 加载一次运行所需的会话状态；会获取会话锁并拼接 checkpoint 与缓冲增量。
   *
   * @param request - 加载请求，含 checkpoint 起点的历史与可选的卡片作答。
   * @param signal - 中止信号；取消后放弃加载并释放已获取的租约。
   * @returns 可直接交给运行的完整会话状态，含本轮持有的租约与失租信号。
   */
  load(request: SessionLoadRequest, signal: AbortSignal): Promise<SessionRunState>
  /**
   * 保存一次运行的结果；无论成功失败都负责释放本轮租约与清理缓冲。
   *
   * @param state - `load` 返回的会话状态，带回 revision、fencing 令牌与租约。
   * @param outcome - 本轮结果，含运行时状态、展示消息与可能的错误。
   * @param signal - 中止信号；取消后放弃保存，但仍需释放租约。
   */
  save(state: SessionRunState, outcome: SessionRunOutcome, signal: AbortSignal): Promise<void>
}
