/*
 * Task 模块的 wire DTO。
 *
 * 命名在**同一个模块内是混用的**：任务实体用 PascalCase（TaskID / ScheduleType …），
 * 分页、偏好与补丁类字段用 snake_case。这是既有契约，前后端两侧都按此解析，
 * 改名必须两侧同步——不要按「统一风格」的直觉只改一边。
 */
import type { PersistedDisplayMessageDto } from '../presentation/dto.js'

/** 调度方式：单次 或 周期。 */
export type TaskScheduleType = 'once' | 'recurring'
/** 单次执行状态的四态联合；失败原因在 `ErrorMessage` 里，状态本身不带原因。 */
export type TaskExecutionStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 更新任务请求；当前唯一可改的字段是启用状态。 */
export interface UpdateTaskDto {
  readonly is_active: boolean
}

/** 已读/折叠偏好的补丁；两个字段至少给一个，空对象会被拒。 */
export interface ExecutionViewStatePatchDto {
  readonly mark_seen?: true | undefined
  readonly collapsed_override?: boolean | undefined
}

/** 任务实体；`RunAt` / `NextRunAt` 是 ISO 字符串，无值时不出现该键。 */
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

/** 执行摘要；供列表内嵌，不含展示消息。可空字段统一填 null。 */
export interface TaskExecutionSummaryDto {
  readonly ExecutionID: string
  readonly Status: TaskExecutionStatus
  readonly ScheduledAt: string
  readonly StartedAt: string | null
  readonly CompletedAt: string | null
  readonly ResultMessage: string | null
  readonly ErrorMessage: string | null
}

/** 任务列表项：任务实体 + 会话标题 + 最近一次执行摘要（从未执行时为 null）。 */
export interface TaskListItemDto extends TaskDto {
  readonly session_title?: string | undefined
  readonly latest_execution: TaskExecutionSummaryDto | null
}

/** 任务列表页；`next_cursor` 为空串表示没有下一页。 */
export interface TaskListDto {
  readonly tasks: TaskListItemDto[]
  readonly next_cursor: string
}

/** 单次执行的完整记录；`DisplayMessages` 是持久化形态的展示消息（非中性 Runtime 消息）。 */
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

/** 执行记录的分页结果；游标语义与 `TaskListDto` 相同。 */
export interface TaskExecutionListDto {
  readonly executions: TaskExecutionDto[]
  readonly next_cursor: string
}

/** 已读/折叠偏好；三个可空字段为 null 表示用户未设置，与 false 语义不同。 */
export interface ExecutionViewStateDto {
  readonly execution_id: string
  readonly seen_at: string | null
  readonly collapsed_override: boolean | null
  readonly updated_at: string | null
}
