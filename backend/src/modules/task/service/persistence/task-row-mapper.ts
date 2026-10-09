import { z } from 'zod'
import { optionalField } from './../../../../shared/object/optional-field.js'
import { truncateCodePoints } from './../../../../shared/text/truncate-code-points.js'

import type {
  Card,
  DisplayMessage,
  MessageMeta,
  ScheduledTaskMeta,
} from './../../../agent/public-api.js'
import type {
  AgentTaskDefinition,
  AgentTaskExecution,
  AgentTaskExecutionSummary,
  AgentTaskListItem,
  ExecutionViewState,
  TaskPage,
} from './../../model/task.js'

/** PostgreSQL task rows 的运行时校验与领域映射；不负责执行 SQL。 */
const nullableDateSchema = z.date().nullable()
const nullableStringSchema = z.string().nullable()

const scheduledTaskRowSchema = z.object({
  scheduled_task_id: z.string(),
  session_id: z.string(),
  user_id: z.string(),
  task_input: z.string(),
  schedule_type: z.union([z.literal(''), z.enum(['once', 'recurring'])]),
  run_at: nullableDateSchema,
  cron_expr: nullableStringSchema,
  next_run_at: nullableDateSchema,
  is_active: z.boolean(),
  retry_count: z.number().int(),
  is_recurring: z.boolean(),
  created_at: z.date(),
})

const cardSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.json()),
})

const scheduledTaskMetaSchema = z.object({
  task_id: z.string(),
  task_name: z.string(),
  status: z.enum(['completed', 'failed']),
  execution_id: z.string(),
  scheduled_at: z.number().finite(),
  completed_at: z.number().finite(),
})

const messageMetaSchema = z.object({
  scheduled_task: scheduledTaskMetaSchema.optional(),
  run_started_at: z.number().finite().optional(),
})

const displayMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  cards: z.array(cardSchema).optional(),
  sections: z.json().optional(),
  source: z.string().optional(),
  meta: messageMetaSchema.optional(),
  timestamp: z.number().finite(),
})

const executionRowSchema = z.object({
  execution_id: z.string(),
  task_id: z.string(),
  session_id: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  scheduled_at: z.date(),
  started_at: nullableDateSchema,
  completed_at: nullableDateSchema,
  display_messages: z.array(displayMessageSchema),
  result_type: nullableStringSchema,
  result_message: nullableStringSchema,
  error_message: nullableStringSchema,
  delivered: z.boolean(),
  created_at: z.date(),
})

const taskListRowSchema = scheduledTaskRowSchema.extend({
  session_title: z.string(),
  latest_execution_id: nullableStringSchema,
  latest_status: z.enum(['pending', 'running', 'completed', 'failed']).nullable(),
  latest_scheduled_at: nullableDateSchema,
  latest_started_at: nullableDateSchema,
  latest_completed_at: nullableDateSchema,
  latest_result_message: nullableStringSchema,
  latest_error_message: nullableStringSchema,
})

const viewStateRowSchema = z.object({
  execution_id: z.string(),
  seen_at: nullableDateSchema,
  collapsed_override: z.boolean().nullable(),
  updated_at: nullableDateSchema,
})

export const retryCountRowSchema = z.object({ retry_count: z.number().int().nonnegative() })
interface TaskListCursor {
  readonly createdAt: Date
  readonly taskId: string
}

export function encodeTaskListCursor(createdAt: Date, taskId: string): string {
  return Buffer.from(`${createdAt.toISOString()}\n${taskId}`, 'utf8').toString('base64url')
}

export function decodeTaskListCursor(value: string): TaskListCursor | undefined {
  if (value === '') return undefined
  let decoded: string
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
  const separator = decoded.indexOf('\n')
  if (separator <= 0 || separator === decoded.length - 1) return undefined
  const timestamp = decoded.slice(0, separator)
  const taskId = decoded.slice(separator + 1)
  const createdAt = new Date(timestamp)
  if (Number.isNaN(createdAt.valueOf()) || !isCanonicalBase64Url(value, decoded)) return undefined
  return { createdAt, taskId }
}

export function mapScheduledTaskRow(value: unknown): AgentTaskDefinition {
  const parsed = scheduledTaskRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('定时任务行数据无效', { cause: parsed.error })
  return toTaskDefinition(parsed.data)
}

export function mapExecutionRow(value: unknown): AgentTaskExecution {
  const parsed = executionRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('执行记录行数据无效', { cause: parsed.error })
  const row = parsed.data
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    ...optionalField('startedAt', row.started_at),
    ...optionalField('completedAt', row.completed_at),
    displayMessages: row.display_messages.map(toDisplayMessage),
    ...optionalField('resultType', row.result_type),
    ...optionalField('resultMessage', row.result_message),
    ...optionalField('errorMessage', row.error_message),
    delivered: row.delivered,
  }
}

export function mapTaskListRow(value: unknown): AgentTaskListItem {
  const parsed = taskListRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('任务列表行数据无效', { cause: parsed.error })
  const row = parsed.data
  const task = toTaskDefinition(row)
  const item: AgentTaskListItem = {
    ...task,
    sessionTitle: truncateCodePoints(row.session_title.trim(), 30, '...'),
  }
  if (row.latest_execution_id === null) return item
  if (row.latest_scheduled_at === null) {
    throw new Error('任务列表行数据无效：最新执行缺少调度时间')
  }
  if (row.latest_status === null) {
    throw new Error('任务列表行数据无效：最新执行缺少状态')
  }
  const latestExecution: AgentTaskExecutionSummary = {
    executionId: row.latest_execution_id,
    status: row.latest_status,
    scheduledAt: row.latest_scheduled_at,
    startedAt: row.latest_started_at ?? undefined,
    completedAt: row.latest_completed_at ?? undefined,
    resultMessage: truncateOptionalText(row.latest_result_message, 256),
    errorMessage: truncateOptionalText(row.latest_error_message, 256),
  }
  return { ...item, latestExecution }
}

export function mapViewStateRow(value: unknown): ExecutionViewState {
  const parsed = viewStateRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid task view-state row', { cause: parsed.error })
  return {
    executionId: parsed.data.execution_id,
    ...optionalField('seenAt', parsed.data.seen_at),
    ...optionalField('collapsedOverride', parsed.data.collapsed_override),
    ...optionalField('updatedAt', parsed.data.updated_at),
  }
}
function toTaskDefinition(row: z.infer<typeof scheduledTaskRowSchema>): AgentTaskDefinition {
  return {
    taskId: row.scheduled_task_id,
    sessionId: row.session_id,
    userId: row.user_id,
    taskInput: row.task_input,
    scheduleType: taskScheduleType(row.schedule_type, row.is_recurring),
    runAt: row.run_at ?? undefined,
    cronExpr: row.cron_expr ?? '',
    nextRunAt: row.next_run_at ?? undefined,
    isActive: row.is_active,
    retryCount: row.retry_count,
  }
}

function toDisplayMessage(row: z.infer<typeof displayMessageSchema>): DisplayMessage {
  return {
    role: row.role,
    ...optionalField('content', row.content),
    ...optionalField('cards', row.cards?.map(toCard)),
    ...optionalField('sections', row.sections),
    ...optionalField('source', row.source),
    ...optionalField('meta', row.meta === undefined ? undefined : toMessageMeta(row.meta)),
    timestamp: row.timestamp,
  }
}

function toCard(row: z.infer<typeof cardSchema>): Card {
  return { type: row.type, data: row.data }
}

function toMessageMeta(row: z.infer<typeof messageMetaSchema>): MessageMeta {
  return {
    ...optionalField(
      'scheduledTask',
      row.scheduled_task === undefined ? undefined : toScheduledTaskMeta(row.scheduled_task)
    ),
    ...optionalField('runStartedAt', row.run_started_at),
  }
}
export function parseTaskListRow(value: unknown): z.infer<typeof taskListRowSchema> {
  const parsed = taskListRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('任务列表行数据无效', { cause: parsed.error })
  return parsed.data
}

export function taskPage(
  rows: readonly unknown[],
  limit: number,
  mapper: (value: unknown) => AgentTaskDefinition
): TaskPage<AgentTaskDefinition> {
  const hasMore = rows.length > limit
  const selected = hasMore ? rows.slice(0, limit) : rows
  const last = selected.at(-1)
  const parsedLast = last === undefined ? undefined : scheduledTaskRowSchema.safeParse(last)
  if (parsedLast !== undefined && !parsedLast.success) {
    throw new Error('定时任务行数据无效', { cause: parsedLast.error })
  }
  return {
    items: selected.map(mapper),
    nextCursor:
      hasMore && parsedLast?.success === true ? parsedLast.data.created_at.toISOString() : '',
  }
}

export function executionPage(
  rows: readonly unknown[],
  limit: number
): TaskPage<AgentTaskExecution> {
  const hasMore = rows.length > limit
  const selected = hasMore ? rows.slice(0, limit) : rows
  const parsed = selected.map((row: unknown): z.infer<typeof executionRowSchema> => {
    const result = executionRowSchema.safeParse(row)
    if (!result.success) throw new Error('执行记录行数据无效', { cause: result.error })
    return result.data
  })
  return {
    items: parsed.map(mapExecutionRow),
    nextCursor: hasMore ? (parsed.at(-1)?.created_at.toISOString() ?? '') : '',
  }
}

function truncateOptionalText(value: string | null, maxLength: number): string | undefined {
  return value === null ? undefined : truncateCodePoints(value, maxLength)
}
function isCanonicalBase64Url(encoded: string, decoded: string): boolean {
  return Buffer.from(decoded, 'utf8').toString('base64url') === encoded
}

/** schedule_type 为空是历史写入的兼容回退：旧实现只维护 is_recurring 布尔。 */
function taskScheduleType(
  scheduleType: '' | 'once' | 'recurring',
  isRecurring: boolean
): 'once' | 'recurring' {
  return scheduleType === '' ? (isRecurring ? 'recurring' : 'once') : scheduleType
}

/** 展示消息中的定时任务来源信息；字段名从行快照映射到产品模型。 */
function toScheduledTaskMeta(row: z.infer<typeof scheduledTaskMetaSchema>): ScheduledTaskMeta {
  return {
    taskId: row.task_id,
    taskName: row.task_name,
    status: row.status,
    executionId: row.execution_id,
    scheduledAt: row.scheduled_at,
    completedAt: row.completed_at,
  }
}
