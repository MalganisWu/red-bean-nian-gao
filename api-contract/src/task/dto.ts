import type { PersistedDisplayMessageDto } from '../presentation/dto.js'

export type TaskScheduleType = 'once' | 'recurring'
export type TaskExecutionStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface UpdateTaskDto {
  readonly is_active: boolean
}

export interface ExecutionViewStatePatchDto {
  readonly mark_seen?: true | undefined
  readonly collapsed_override?: boolean | undefined
}

export interface TaskDto {
  readonly TaskID: string
  readonly UserID: string
  readonly SessionID: string
  readonly TaskInput: string
  readonly RunAt?: string | undefined
  readonly CronExpr: string
  readonly ScheduleType: TaskScheduleType
  readonly IsActive: boolean
  readonly RetryCount: number
  readonly NextRunAt?: string | undefined
}

export interface TaskExecutionSummaryDto {
  readonly ExecutionID: string
  readonly Status: TaskExecutionStatus
  readonly ScheduledAt: string
  readonly StartedAt: string | null
  readonly CompletedAt: string | null
  readonly ResultMessage: string | null
  readonly ErrorMessage: string | null
}

export interface TaskListItemDto extends TaskDto {
  readonly session_title?: string | undefined
  readonly latest_execution: TaskExecutionSummaryDto | null
}

export interface TaskListDto {
  readonly tasks: TaskListItemDto[]
  readonly next_cursor: string
}

export interface TaskExecutionDto {
  readonly ExecutionID: string
  readonly TaskID: string
  readonly SessionID: string
  readonly Status: TaskExecutionStatus
  readonly ScheduledAt: string
  readonly StartedAt: string | null
  readonly CompletedAt: string | null
  readonly DisplayMessages: PersistedDisplayMessageDto[]
  readonly ResultType: string | null
  readonly ResultMessage: string | null
  readonly ErrorMessage: string | null
}

export interface TaskExecutionListDto {
  readonly executions: TaskExecutionDto[]
  readonly next_cursor: string
}

export interface ExecutionViewStateDto {
  readonly execution_id: string
  readonly seen_at: string | null
  readonly collapsed_override: boolean | null
  readonly updated_at: string | null
}
