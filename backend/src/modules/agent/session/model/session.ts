import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { StoredRuntimeState } from '../../execution/model/runtime-state.js'

export const SESSION_STORE_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'session_not_found',
  REVISION_CONFLICT: 'session_revision_conflict',
  STALE_FENCE: 'session_stale_fence',
  INTERACTION_CONFLICT: 'session_interaction_conflict',
} as const)

export type SessionStoreErrorCode =
  (typeof SESSION_STORE_ERROR_CODES)[keyof typeof SESSION_STORE_ERROR_CODES]

export class SessionStoreError extends Error {
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

export interface AnswerMarker {
  readonly interactionId: string
  readonly answers: Readonly<Record<string, unknown>>
  readonly refused: boolean
}

export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly messageCount: number
  readonly updatedAt: Date
}

export interface Session {
  readonly id: string
  readonly userId: string
  runtimeState?: StoredRuntimeState | undefined
  displayMessages: DisplayMessage[]
  revision: bigint
  fencingToken: bigint
}
