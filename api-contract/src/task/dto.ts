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
  /** 是否启用该任务；false 表示暂停，不触发后续执行。 */
  readonly is_active: boolean
}

/** 已读/折叠偏好的补丁；两个字段至少给一个，空对象会被拒。 */
export interface ExecutionViewStatePatchDto {
  /** 置为 true 表示把该执行标记为已读；它表达一个动作，不是一个开关，因此只接受字面量 true。 */
  readonly mark_seen?: true | undefined
  /** 折叠状态覆盖值；缺省表示不改动该项，与 false（显式展开）语义不同。 */
  readonly collapsed_override?: boolean | undefined
}

/** 任务实体；`RunAt` / `NextRunAt` 是 ISO 字符串，无值时不出现该键。 */
export interface TaskDto {
  /** 任务 ID。 */
  readonly TaskID: string
  /** 任务归属的用户 ID。 */
  readonly UserID: string
  /** 任务绑定的会话 ID，执行结果写入该会话。 */
  readonly SessionID: string
  /** 任务提示词正文，执行时作为输入。 */
  readonly TaskInput: string
  /** 单次任务的计划执行时刻，ISO 8601 字符串；周期任务缺省该键。 */
  readonly RunAt?: string | undefined
  /** 周期任务的 cron 表达式；单次任务为空串。 */
  readonly CronExpr: string
  /** 调度方式：once 单次、recurring 周期。 */
  readonly ScheduleType: TaskScheduleType
  /** 是否启用；暂停的任务不参与调度。 */
  readonly IsActive: boolean
  /** 已重试次数；达到上限后不再重试。 */
  readonly RetryCount: number
  /** 下一次计划执行时刻，ISO 8601 字符串；无下次时缺省该键。 */
  readonly NextRunAt?: string | undefined
}

/** 执行摘要；供列表内嵌，不含展示消息。可空字段统一填 null。 */
export interface TaskExecutionSummaryDto {
  /** 执行记录 ID。 */
  readonly ExecutionID: string
  /** 执行状态四态之一。 */
  readonly Status: TaskExecutionStatus
  /** 计划触发时刻，ISO 8601 字符串。 */
  readonly ScheduledAt: string
  /** 实际开始时刻，ISO 8601 字符串；未开始时为 null。 */
  readonly StartedAt: string | null
  /** 完成时刻，ISO 8601 字符串；未完成时为 null。 */
  readonly CompletedAt: string | null
  /** 结果摘要；无结果时为 null。 */
  readonly ResultMessage: string | null
  /** 失败原因；无错误时为 null。 */
  readonly ErrorMessage: string | null
}

/** 任务列表项：任务实体 + 会话标题 + 最近一次执行摘要（从未执行时为 null）。 */
export interface TaskListItemDto extends TaskDto {
  /** 任务绑定会话的标题；会话不存在或缺省未写入时为 undefined。 */
  readonly session_title?: string | undefined
  /** 最近一次执行摘要；从未执行时为 null。 */
  readonly latest_execution: TaskExecutionSummaryDto | null
}

/** 任务列表页；`next_cursor` 为空串表示没有下一页。 */
export interface TaskListDto {
  /** 当前页的任务列表项。 */
  readonly tasks: TaskListItemDto[]
  /** 下一页游标；空串表示没有下一页。 */
  readonly next_cursor: string
}

/** 单次执行的完整记录；`DisplayMessages` 是持久化形态的展示消息（非中性 Runtime 消息）。 */
export interface TaskExecutionDto {
  /** 执行记录 ID。 */
  readonly ExecutionID: string
  /** 所属任务 ID。 */
  readonly TaskID: string
  /** 执行结果写入的会话 ID。 */
  readonly SessionID: string
  /** 执行状态四态之一。 */
  readonly Status: TaskExecutionStatus
  /** 计划触发时刻，ISO 8601 字符串。 */
  readonly ScheduledAt: string
  /** 实际开始时刻，ISO 8601 字符串；未开始时为 null。 */
  readonly StartedAt: string | null
  /** 完成时刻，ISO 8601 字符串；未完成时为 null。 */
  readonly CompletedAt: string | null
  /** 该次执行产生的展示消息，按时间升序。 */
  readonly DisplayMessages: PersistedDisplayMessageDto[]
  /** 结果类型标识；无结果时为 null。 */
  readonly ResultType: string | null
  /** 结果摘要；无结果时为 null。 */
  readonly ResultMessage: string | null
  /** 失败原因；无错误时为 null。 */
  readonly ErrorMessage: string | null
}

/** 执行记录的分页结果；游标语义与 `TaskListDto` 相同。 */
export interface TaskExecutionListDto {
  /** 当前页的执行记录。 */
  readonly executions: TaskExecutionDto[]
  /** 下一页游标；空串表示没有下一页。 */
  readonly next_cursor: string
}

/** 已读/折叠偏好；三个可空字段为 null 表示用户未设置，与 false 语义不同。 */
export interface ExecutionViewStateDto {
  /** 对应的执行记录 ID。 */
  readonly execution_id: string
  /** 标记为已读的时刻，ISO 8601 字符串；null 表示用户未设置。 */
  readonly seen_at: string | null
  /** 折叠状态覆盖；null 表示未设置，与 false（显式展开）语义不同。 */
  readonly collapsed_override: boolean | null
  /** 该行最近更新时刻，ISO 8601 字符串；null 表示尚未更新过。 */
  readonly updated_at: string | null
}
