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

/** 只取 `retry_count` 的行 schema；重试路径只需要这一个字段，不必拉整行。 */
export const retryCountRowSchema = z.object({ retry_count: z.number().int().nonnegative() })
interface TaskListCursor {
  readonly createdAt: Date
  readonly taskId: string
}

/** 键集分页游标：`created_at` 与 `task_id` 一起编码，避免同一毫秒内建的任务在翻页时被跳过或重复。 */
export function encodeTaskListCursor(createdAt: Date, taskId: string): string {
  return Buffer.from(`${createdAt.toISOString()}\n${taskId}`, 'utf8').toString('base64url')
}

/**
 * 解码游标；空串与任何畸形输入都返回 `undefined`，由调用方决定回退语义（通常是取首页）。
 * 这里刻意不抛错：游标是客户端回传的数据，把它当作不可信输入处理，坏游标不该让整个列表 500。
 * `isCanonicalBase64Url` 用来挡掉「同一串字节的多种 base64 写法」，保证游标可比较。
 */
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

/** 校验并映射单行 `scheduled_tasks`；schema 不匹配直接抛错，不做「尽力填默认值」的兜底。 */
export function mapScheduledTaskRow(value: unknown): AgentTaskDefinition {
  const parsed = scheduledTaskRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('定时任务行数据无效', { cause: parsed.error })
  return toTaskDefinition(parsed.data)
}

/** 校验并映射单行 `agent_task_executions`；可空列经 `optionalField` 折叠成「字段缺失」而非 `null`。 */
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

/**
 * 映射列表行：任务本体 + 会话标题 + 最近执行摘要。
 * 摘要「有 id 就必须有状态与调度时间」是全有或全无的判定——半截数据说明 SQL 与 schema 已经漂移，
 * 与其渲染出一张空摘要卡片，不如在这里就失败。
 * 标题与摘要文案都做截断，列表接口不该被单条超长文本撑大。
 */
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

/** 映射已读/折叠偏好行；三个可空字段缺省即表示「用户未设置」，由前端按默认规则决定呈现。 */
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
/** 只校验不映射，供需要读到原始列（如算游标用的 `created_at`）的调用点使用。 */
export function parseTaskListRow(value: unknown): z.infer<typeof taskListRowSchema> {
  const parsed = taskListRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('任务列表行数据无效', { cause: parsed.error })
  return parsed.data
}

/**
 * 任务分页：多取一行来判断是否存在下页，再截断到 `limit`。
 * 游标取自截断后最后一行的 `created_at`——用被丢弃的那一行会让下一页从错误的边界开始。
 * 空串游标表示没有下页，这是分页约定的终止值。
 */
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

/** 执行记录分页；与 `taskPage` 同为「多取一行」策略，但整页先全量校验再映射，坏行不会被静默跳过。 */
export function executionPage(
  rows: readonly unknown[],
  limit: number
): TaskPage<AgentTaskExecution> {
  const hasMore = rows.length > limit
  const selected = hasMore ? rows.slice(0, limit) : rows
  const parsed = selected.map(parseExecutionRow)
  return {
    items: parsed.map(mapExecutionRow),
    nextCursor: hasMore ? (parsed.at(-1)?.created_at.toISOString() ?? '') : '',
  }
}

/** 校验单条执行记录行；任一行非法即抛错，坏行不会被静默跳过。 */
function parseExecutionRow(row: unknown): z.infer<typeof executionRowSchema> {
  const result = executionRowSchema.safeParse(row)
  if (!result.success) throw new Error('执行记录行数据无效', { cause: result.error })
  return result.data
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
