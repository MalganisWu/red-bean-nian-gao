import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { StoredRuntimeState } from '../../execution/model/runtime-state.js'

/** 会话仓储的稳定错误码；用例层据此映射成面向用户的错误，不直接把 message 透出。 */
export const SESSION_STORE_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'session_not_found',
  REVISION_CONFLICT: 'session_revision_conflict',
  STALE_FENCE: 'session_stale_fence',
  INTERACTION_CONFLICT: 'session_interaction_conflict',
} as const)

/** 错误码的字面量联合。 */
export type SessionStoreErrorCode =
  (typeof SESSION_STORE_ERROR_CODES)[keyof typeof SESSION_STORE_ERROR_CODES]

/** 仓储层异常；`code` 是机器判据，`message` 只供日志，对外文案由用例层重新给。 */
export class SessionStoreError extends Error {
  /** 机器判据；用例层据此映射用户文案，不要拿 `message` 做分支。 */
  public readonly code: SessionStoreErrorCode

  public constructor(code: SessionStoreErrorCode, message: string) {
    super(message)
    this.name = 'SessionStoreError'
    this.code = code
  }
}

/** 查询目标 Session 不存在，或不属于当前用户。 */
export class SessionNotFoundError extends Error {
  public constructor(options?: ErrorOptions) {
    super('会话不存在', options)
    this.name = 'SessionNotFoundError'
  }
}

/**
 * 用户对一张交互卡片的作答。
 * `refused` 与「答案为空」是两件事：前者是用户明确拒绝，卡片状态记 `refused`；
 * 后者是还没答或答了空，因此不能用 `answers` 是否为空来判断拒答。
 */
export interface AnswerMarker {
  /** 目标交互卡片标识；决定作答写回哪一张卡片，与 `answers` 语义无关。 */
  readonly interactionId: string
  /** 用户选择的答案；拒答时也可能为空，因此不能拿它判拒答。 */
  readonly answers: Readonly<Record<string, unknown>>
  /** 用户是否明确拒答；与「答案为空」是两件事，是拒答语义的唯一判据。 */
  readonly refused: boolean
}

/** 会话列表项；只带列表需要的字段，不含 `runtimeState` 与完整消息列表。 */
export interface SessionSummary {
  /** 会话标识；列表项按它定位详情，不要在展示层重复拼装。 */
  readonly id: string
  /** 会话标题；由首条用户消息推导，可能为空串，展示层需自行兜底文案。 */
  readonly title: string
  /** 会话内的消息条数；只用于列表展示，不参与分页游标计算。 */
  readonly messageCount: number
  /** 会话最后更新时间；列表排序依据，语义是最后一次成功持久化的时间。 */
  readonly updatedAt: Date
}

/** 会话聚合根；`revision` 与 `fencingToken` 是并发控制的判据，回写时必须原样带回。 */
export interface Session {
  /** 会话标识；同一会话在全部存储层使用同一 id。 */
  readonly id: string
  /** 会话归属用户；仓储层据此做所有权校验，跨用户访问一律视为不存在。 */
  readonly userId: string
  /** 上一轮运行留下的运行时状态；缺省表示会话尚无 checkpoint 可恢复。 */
  runtimeState?: StoredRuntimeState | undefined
  /** 面向展示的消息历史；与运行态消息分离，仅承载已投影的展示结构。 */
  displayMessages: DisplayMessage[]
  /** 乐观并发版本号；每次成功回写递增，保存时带上旧值以拒绝覆盖并发写。 */
  revision: bigint
  /** 会话锁的 fencing 令牌；回写时原样带回，令牌陈旧即拒绝写入。 */
  fencingToken: bigint
}
