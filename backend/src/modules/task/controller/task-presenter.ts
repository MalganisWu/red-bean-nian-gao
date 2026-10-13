import type {
  AgentTaskDefinition,
  AgentTaskExecution,
  AgentTaskExecutionSummary,
  AgentTaskListItem,
  ExecutionViewState,
} from './../model/task.js'
import type {
  ExecutionViewStateDto,
  TaskDto,
  TaskExecutionDto,
  TaskExecutionSummaryDto,
  TaskListItemDto,
} from './task.dto.js'
import { toTaskDisplayMessageDto } from './../service/persistence/task-display-message-presenter.js'

/**
 * 任务定义 → wire DTO；时间转 ISO 字符串，可空字段缺省时不写该键。
 *
 * @param task - 领域任务定义；`runAt`/`nextRunAt` 缺省时对应的键整体省略而非填 null。
 * @returns 可直接进响应信封的任务 DTO，字段名沿用契约的大驼峰。
 */
export function toTaskDto(task: AgentTaskDefinition): TaskDto {
  return {
    TaskID: task.taskId,
    UserID: task.userId,
    SessionID: task.sessionId,
    TaskInput: task.taskInput,
    ...(task.runAt === undefined ? {} : { RunAt: task.runAt.toISOString() }),
    CronExpr: task.cronExpr,
    ScheduleType: task.scheduleType,
    IsActive: task.isActive,
    RetryCount: task.retryCount,
    ...(task.nextRunAt === undefined ? {} : { NextRunAt: task.nextRunAt.toISOString() }),
  }
}

/**
 * 列表项 DTO；`latest_execution` 无值时刻意写 `null` 而非省略键，前端据此不必区分两种「没有」。
 *
 * @param item - 列表项，任务本体 + 会话标题 + 最近一次执行摘要（可缺省）。
 * @returns 列表项 DTO；`latest_execution` 恒定存在，无摘要时为 `null`。
 */
export function toTaskListItemDto(item: AgentTaskListItem): TaskListItemDto {
  return {
    ...toTaskDto(item),
    ...(item.sessionTitle === '' ? {} : { session_title: item.sessionTitle }),
    latest_execution:
      item.latestExecution === undefined ? null : toExecutionSummaryDto(item.latestExecution),
  }
}

/**
 * 执行摘要 DTO；可空字段统一填 `null`，字段集始终完整。
 *
 * @param summary - 执行摘要领域对象；可空字段缺省即输出 `null`。
 * @returns 字段集恒定的摘要 DTO，前端无需区分「省略」与「为空」。
 */
export function toExecutionSummaryDto(summary: AgentTaskExecutionSummary): TaskExecutionSummaryDto {
  return {
    ExecutionID: summary.executionId,
    Status: summary.status,
    ScheduledAt: summary.scheduledAt.toISOString(),
    StartedAt: summary.startedAt?.toISOString() ?? null,
    CompletedAt: summary.completedAt?.toISOString() ?? null,
    ResultMessage: summary.resultMessage ?? null,
    ErrorMessage: summary.errorMessage ?? null,
  }
}

/**
 * 执行记录 DTO；展示消息先经 `toTaskDisplayMessageDto` 转成 wire 形状再输出。
 *
 * @param execution - 完整执行记录；`displayMessages` 逐条转 DTO，任一不符合契约即抛错。
 * @returns 执行记录 DTO，可空字段统一填 `null`。
 */
export function toExecutionDto(execution: AgentTaskExecution): TaskExecutionDto {
  return {
    ExecutionID: execution.executionId,
    TaskID: execution.taskId,
    SessionID: execution.sessionId,
    Status: execution.status,
    ScheduledAt: execution.scheduledAt.toISOString(),
    StartedAt: execution.startedAt?.toISOString() ?? null,
    CompletedAt: execution.completedAt?.toISOString() ?? null,
    DisplayMessages: execution.displayMessages.map(toTaskDisplayMessageDto),
    ResultType: execution.resultType ?? null,
    ResultMessage: execution.resultMessage ?? null,
    ErrorMessage: execution.errorMessage ?? null,
  }
}

/**
 * 已读/折叠偏好 DTO；缺省一律填 `null`——注意 `collapsed_override: false` 是有效取值，不等于未设置。
 *
 * @param state - 视图状态领域对象；`collapsedOverride` 为 `undefined` 表示用户未覆盖。
 * @returns 视图状态 DTO，三个可空字段缺省即输出 `null`。
 */
export function toExecutionViewStateDto(state: ExecutionViewState): ExecutionViewStateDto {
  return {
    execution_id: state.executionId,
    seen_at: state.seenAt?.toISOString() ?? null,
    collapsed_override: state.collapsedOverride ?? null,
    updated_at: state.updatedAt?.toISOString() ?? null,
  }
}
