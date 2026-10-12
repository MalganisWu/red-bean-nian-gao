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

/** 任务定义 → wire DTO；时间转 ISO 字符串，可空字段缺省时不写该键。 */
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

/** 列表项 DTO；`latest_execution` 无值时刻意写 `null` 而非省略键，前端据此不必区分两种「没有」。 */
export function toTaskListItemDto(item: AgentTaskListItem): TaskListItemDto {
  return {
    ...toTaskDto(item),
    ...(item.sessionTitle === '' ? {} : { session_title: item.sessionTitle }),
    latest_execution:
      item.latestExecution === undefined ? null : toExecutionSummaryDto(item.latestExecution),
  }
}

/** 执行摘要 DTO；可空字段统一填 `null`，字段集始终完整。 */
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

/** 执行记录 DTO；展示消息先经 `toTaskDisplayMessageDto` 转成 wire 形状再输出。 */
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

/** 已读/折叠偏好 DTO；缺省一律填 `null`——注意 `collapsed_override: false` 是有效取值，不等于未设置。 */
export function toExecutionViewStateDto(state: ExecutionViewState): ExecutionViewStateDto {
  return {
    execution_id: state.executionId,
    seen_at: state.seenAt?.toISOString() ?? null,
    collapsed_override: state.collapsedOverride ?? null,
    updated_at: state.updatedAt?.toISOString() ?? null,
  }
}
