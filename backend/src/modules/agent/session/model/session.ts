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
  readonly interactionId: string
  readonly answers: Readonly<Record<string, unknown>>
  readonly refused: boolean
}

/** 会话列表项；只带列表需要的字段，不含 `runtimeState` 与完整消息列表。 */
export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly messageCount: number
  readonly updatedAt: Date
}

/** 会话聚合根；`revision` 与 `fencingToken` 是并发控制的判据，回写时必须原样带回。 */
export interface Session {
  readonly id: string
  readonly userId: string
  runtimeState?: StoredRuntimeState | undefined
  displayMessages: DisplayMessage[]
  revision: bigint
  fencingToken: bigint
}
