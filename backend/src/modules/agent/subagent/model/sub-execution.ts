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

export type SubExecutionStatus =
  (typeof SUB_EXECUTION_STATUSES)[keyof typeof SUB_EXECUTION_STATUSES]

export const SUB_EXECUTION_STORE_ERROR_CODES = Object.freeze({
  REVISION_CONFLICT: 'sub_execution_revision_conflict',
  RESUME_CONFLICT: 'sub_execution_resume_conflict',
} as const)

export type SubExecutionStoreErrorCode =
  (typeof SUB_EXECUTION_STORE_ERROR_CODES)[keyof typeof SUB_EXECUTION_STORE_ERROR_CODES]

/** 子执行持久化的稳定冲突错误，调用方不得把 CAS 失败降级成普通覆盖写。 */
export class SubExecutionStoreError extends Error {
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
