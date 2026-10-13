import type { StoredRuntimeState } from '../../execution/model/runtime-state.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentJsonValue } from '../../model/json-value.js'

/** 子 Agent 执行在产品域中的状态；数据库枚举只由 Repository Adapter 映射。 */
export const SUB_EXECUTION_STATUSES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  AWAITING_USER: 'awaiting_user',
} as const)

/** 子执行状态的字面量联合；`awaiting_user` 是唯一的中间态，表示在等父 Agent 转达用户作答。 */
export type SubExecutionStatus =
  (typeof SUB_EXECUTION_STATUSES)[keyof typeof SUB_EXECUTION_STATUSES]

/** 子执行仓储的稳定冲突码；两个都是 CAS 类冲突，调用方不得把它降级成普通覆盖写。 */
export const SUB_EXECUTION_STORE_ERROR_CODES = Object.freeze({
  REVISION_CONFLICT: 'sub_execution_revision_conflict',
  RESUME_CONFLICT: 'sub_execution_resume_conflict',
} as const)

/** 冲突码的字面量联合。 */
export type SubExecutionStoreErrorCode =
  (typeof SUB_EXECUTION_STORE_ERROR_CODES)[keyof typeof SUB_EXECUTION_STORE_ERROR_CODES]

/** 子执行持久化的稳定冲突错误，调用方不得把 CAS 失败降级成普通覆盖写。 */
export class SubExecutionStoreError extends Error {
  /** 冲突码；调用方据此区分 revision CAS 冲突与 resume 所有权冲突，不得降级成普通覆盖写。 */
  public readonly code: SubExecutionStoreErrorCode

  public constructor(code: SubExecutionStoreErrorCode, message: string) {
    super(message)
    this.name = 'SubExecutionStoreError'
    this.code = code
  }
}

/** 子 Agent 执行的宿主领域记录，不暴露 PostgreSQL row 命名。 */
export interface SubExecutionRecord {
  readonly executionId: string
  readonly sessionId: string
  readonly requestId: string
  readonly agentId: string
  agentName: string
  readonly userId: string
  userMessage: string
  systemPrompt?: string | undefined
  display: AgentJsonValue
  runtimeState?: StoredRuntimeState | undefined
  recoveryMessages: AgentMessage[]
  modelName?: string | undefined
  tokensUsed: number
  elapsedMilliseconds: number
  status: SubExecutionStatus
  pendingInterruptId?: string | undefined
  resultSummary?: string | undefined
  errorMessage?: string | undefined
  parentCallId?: string | undefined
  readonly createdAt: Date
  updatedAt: Date
  completedAt?: Date | undefined
  revision: bigint
}
