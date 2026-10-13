/*
 * Task 模块的请求 schema 与响应类型守卫；字段名与 `dto.ts` 严格对应。
 * 守卫只在客户端解析服务端响应时使用，因此失败一律判假，不做抛错与兼容填充。
 */
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

/** 任务 ID 的路径参数；空串被拒。 */
export const taskParamsSchema = z.object({ id: z.string().min(1) })
/** 任务 ID + 执行 ID 的组合路径参数，两者都必须非空。 */
export const executionParamsSchema = z.object({ id: z.string().min(1), eid: z.string().min(1) })
/** 更新任务请求体；只有 `is_active` 一个字段。 */
export const updateTaskSchema: z.ZodType<UpdateTaskDto> = z.object({ is_active: z.boolean() })
/**
 * 偏好补丁校验；`mark_seen` 只接受字面量 `true`——它表达「执行标记为已读」这个动作，不是开关。
 */
export const executionViewStatePatchSchema: z.ZodType<ExecutionViewStatePatchDto> = z
  .object({
    mark_seen: z.literal(true).optional(),
    collapsed_override: z.boolean().optional(),
  })
  .refine(
    (value): boolean => value.mark_seen === true || value.collapsed_override !== undefined,
    'empty patch'
  )

/**
 * 执行状态判据；四态之外一律判假。
 * @param value - 待判定的状态值；四个已登记取值之外一律判假。
 * @returns 取值合法时为 true，否则 false。
 */
function isTaskStatus(value: unknown): value is TaskExecutionStatus {
  return ['pending', 'running', 'completed', 'failed'].includes(String(value))
}

/**
 * 任务实体的守卫；两个时间字段可选，其余全部必填。
 * @param value - 待判定的任务对象；`RunAt` / `NextRunAt` 可选，其余必填字段缺一即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
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

/**
 * 执行摘要的守卫；全部字段必填，可空字段须为字符串或 null。
 * @param value - 待判定的执行摘要；任一字段不合法即判假（可空字段接受 null，不接受 undefined）。
 * @returns 形状成立时为 true，否则 false。
 */
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

/**
 * 列表项的守卫：在任务实体之上要求 `latest_execution` 键存在（值可为 null）。
 * @param value - 待判定的列表项；在任务实体判据之上，`latest_execution` 键必须存在。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isTaskListItem(value: unknown): value is TaskListItemDto {
  return (
    isRecord(value) &&
    isOptional(value['session_title'], isString) &&
    (value['latest_execution'] === null || isTaskExecutionSummary(value['latest_execution'])) &&
    isTask(value)
  )
}

/**
 * 任务列表页的守卫；逐项过 `isTaskListItem`。
 * @param value - 待判定的列表响应；`tasks` 每项合法且 `next_cursor` 为字符串。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isTaskList(value: unknown): value is TaskListDto {
  return (
    isRecord(value) && isArrayOf(value['tasks'], isTaskListItem) && isString(value['next_cursor'])
  )
}

/**
 * 执行记录的守卫；展示消息逐条过 `isPersistedDisplayMessage`。
 * @param value - 待判定的执行记录；标识字段与可空文案字段都必查，`DisplayMessages` 逐条合法。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
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

/**
 * 执行记录列表页的守卫；逐条过 `isTaskExecution`。
 * @param value - 待判定的列表响应；`executions` 每条合法且 `next_cursor` 为字符串。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isTaskExecutionList(value: unknown): value is TaskExecutionListDto {
  return (
    isRecord(value) &&
    isArrayOf(value['executions'], isTaskExecution) &&
    isString(value['next_cursor'])
  )
}

/**
 * 偏好行的守卫；`collapsed_override` 只接受 null 或布尔。
 * @param value - 待判定的偏好行；`execution_id` 必需，三个时间/状态字段按可空判据校验。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isExecutionViewState(value: unknown): value is ExecutionViewStateDto {
  return (
    isRecord(value) &&
    isString(value['execution_id']) &&
    isNullableString(value['seen_at']) &&
    (value['collapsed_override'] === null || isBoolean(value['collapsed_override'])) &&
    isNullableString(value['updated_at'])
  )
}
