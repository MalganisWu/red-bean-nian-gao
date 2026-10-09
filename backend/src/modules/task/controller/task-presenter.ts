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

export function toTaskListItemDto(item: AgentTaskListItem): TaskListItemDto {
  return {
    ...toTaskDto(item),
    ...(item.sessionTitle === '' ? {} : { session_title: item.sessionTitle }),
    latest_execution:
      item.latestExecution === undefined ? null : toExecutionSummaryDto(item.latestExecution),
  }
}

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

export function toExecutionViewStateDto(state: ExecutionViewState): ExecutionViewStateDto {
  return {
    execution_id: state.executionId,
    seen_at: state.seenAt?.toISOString() ?? null,
    collapsed_override: state.collapsedOverride ?? null,
    updated_at: state.updatedAt?.toISOString() ?? null,
  }
}
