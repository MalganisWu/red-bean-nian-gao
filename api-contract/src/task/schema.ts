import type {
  ExecutionViewStateDto,
  ExecutionViewStatePatchDto,
  TaskDto,
  TaskExecutionDto,
  TaskExecutionListDto,
  TaskExecutionStatus,
  TaskExecutionSummaryDto,
  TaskListDto,
  TaskListItemDto,
  UpdateTaskDto,
} from './dto.js'
import { z } from 'zod'
import {
  isArrayOf,
  isBoolean,
  isNullableString,
  isNumber,
  isOptional,
  isRecord,
  isString,
} from '../common/schema.js'
import { isPersistedDisplayMessage } from '../presentation/schema.js'

export const taskParamsSchema = z.object({ id: z.string().min(1) })
export const executionParamsSchema = z.object({ id: z.string().min(1), eid: z.string().min(1) })
export const updateTaskSchema: z.ZodType<UpdateTaskDto> = z.object({ is_active: z.boolean() })
export const executionViewStatePatchSchema: z.ZodType<ExecutionViewStatePatchDto> = z
  .object({
    mark_seen: z.literal(true).optional(),
    collapsed_override: z.boolean().optional(),
  })
  .refine(
    (value): boolean => value.mark_seen === true || value.collapsed_override !== undefined,
    'empty patch'
  )

function isTaskStatus(value: unknown): value is TaskExecutionStatus {
  return ['pending', 'running', 'completed', 'failed'].includes(String(value))
}

export function isTask(value: unknown): value is TaskDto {
  if (
    !isRecord(value) ||
    !isString(value['TaskID']) ||
    !isString(value['SessionID']) ||
    !isString(value['UserID']) ||
    !isString(value['TaskInput']) ||
    !['once', 'recurring'].includes(String(value['ScheduleType'])) ||
    !isString(value['CronExpr']) ||
    !isBoolean(value['IsActive']) ||
    !isNumber(value['RetryCount'])
  ) {
    return false
  }
  return isOptional(value['RunAt'], isString) && isOptional(value['NextRunAt'], isString)
}

function isTaskExecutionSummary(value: unknown): value is TaskExecutionSummaryDto {
  return (
    isRecord(value) &&
    isString(value['ExecutionID']) &&
    isTaskStatus(value['Status']) &&
    isString(value['ScheduledAt']) &&
    isNullableString(value['StartedAt']) &&
    isNullableString(value['CompletedAt']) &&
    isNullableString(value['ResultMessage']) &&
    isNullableString(value['ErrorMessage'])
  )
}

export function isTaskListItem(value: unknown): value is TaskListItemDto {
  return (
    isRecord(value) &&
    isOptional(value['session_title'], isString) &&
    (value['latest_execution'] === null || isTaskExecutionSummary(value['latest_execution'])) &&
    isTask(value)
  )
}

export function isTaskList(value: unknown): value is TaskListDto {
  return (
    isRecord(value) && isArrayOf(value['tasks'], isTaskListItem) && isString(value['next_cursor'])
  )
}

export function isTaskExecution(value: unknown): value is TaskExecutionDto {
  return (
    isRecord(value) &&
    isString(value['ExecutionID']) &&
    isString(value['TaskID']) &&
    isString(value['SessionID']) &&
    isTaskStatus(value['Status']) &&
    isString(value['ScheduledAt']) &&
    isNullableString(value['StartedAt']) &&
    isNullableString(value['CompletedAt']) &&
    isArrayOf(value['DisplayMessages'], isPersistedDisplayMessage) &&
    isNullableString(value['ResultType']) &&
    isNullableString(value['ResultMessage']) &&
    isNullableString(value['ErrorMessage'])
  )
}

export function isTaskExecutionList(value: unknown): value is TaskExecutionListDto {
  return (
    isRecord(value) &&
    isArrayOf(value['executions'], isTaskExecution) &&
    isString(value['next_cursor'])
  )
}

export function isExecutionViewState(value: unknown): value is ExecutionViewStateDto {
  return (
    isRecord(value) &&
    isString(value['execution_id']) &&
    isNullableString(value['seen_at']) &&
    (value['collapsed_override'] === null || isBoolean(value['collapsed_override'])) &&
    isNullableString(value['updated_at'])
  )
}
