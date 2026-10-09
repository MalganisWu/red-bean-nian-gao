import type { DisplayMessage } from './../../agent/public-api.js'

/** Task Domain 自有状态；Wire DTO 由 Presenter 显式映射，禁止反向依赖 API Contract。 */
export type TaskScheduleType = 'once' | 'recurring'
export type TaskExecutionStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface AgentTaskDefinition {
  readonly taskId: string
  readonly userId: string
  readonly sessionId: string
  taskInput: string
  runAt?: Date | undefined
  cronExpr: string
  scheduleType: TaskScheduleType
  isActive: boolean
  retryCount: number
  nextRunAt?: Date | undefined
}

export interface AgentTaskExecution {
  readonly executionId: string
  readonly taskId: string
  readonly sessionId: string
  status: TaskExecutionStatus
  readonly scheduledAt: Date
  readonly startedAt?: Date | undefined
  completedAt?: Date | undefined
  readonly displayMessages: readonly DisplayMessage[]
  readonly resultType?: string | undefined
  readonly resultMessage?: string | undefined
  readonly errorMessage?: string | undefined
  readonly delivered: boolean
}

export interface AgentTaskExecutionSummary {
  readonly executionId: string
  readonly status: TaskExecutionStatus
  readonly scheduledAt: Date
  readonly startedAt?: Date | undefined
  readonly completedAt?: Date | undefined
  readonly resultMessage?: string | undefined
  readonly errorMessage?: string | undefined
}

export interface AgentTaskListItem extends AgentTaskDefinition {
  readonly sessionTitle: string
  readonly latestExecution?: AgentTaskExecutionSummary | undefined
}

export interface ExecutionViewState {
  readonly executionId: string
  readonly seenAt?: Date | undefined
  readonly collapsedOverride?: boolean | undefined
  readonly updatedAt?: Date | undefined
}

export interface TaskPage<TItem> {
  readonly items: readonly TItem[]
  readonly nextCursor: string
}

export const TASK_REPOSITORY_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'task_not_found',
  NOT_AUTHORIZED: 'task_not_authorized',
  STALE_EXECUTION: 'task_stale_execution',
} as const)

export type TaskRepositoryErrorCode =
  (typeof TASK_REPOSITORY_ERROR_CODES)[keyof typeof TASK_REPOSITORY_ERROR_CODES]

export class TaskRepositoryError extends Error {
  public readonly code: TaskRepositoryErrorCode

  public constructor(code: TaskRepositoryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TaskRepositoryError'
    this.code = code
  }
}
