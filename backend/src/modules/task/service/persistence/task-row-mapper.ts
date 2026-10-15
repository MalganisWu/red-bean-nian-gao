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
/** 可空文本列；NULL 是合法值，映射时再折叠成字段缺省而非 `null`。 */
const nullableStringSchema = z.string().nullable()

/** `scheduled_tasks` 单行的校验 schema；列清单见 `task-sql.ts` 的 TASK_COLUMNS。 */
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

/** 展示消息内嵌卡片：`type` 为卡片类型，`data` 为自由形状的 JSON 负载。 */
const cardSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.json()),
})

/** 展示消息 meta 里定时任务来源的快照；时间字段为毫秒时间戳。 */
const scheduledTaskMetaSchema = z.object({
  task_id: z.string(),
  task_name: z.string(),
  status: z.enum(['completed', 'failed']),
  execution_id: z.string(),
  scheduled_at: z.number().finite(),
  completed_at: z.number().finite(),
})

/** 展示消息 meta：定时任务来源与运行开始时刻都可缺省，非定时任务消息两者皆无。 */
const messageMetaSchema = z.object({
  scheduled_task: scheduledTaskMetaSchema.optional(),
  run_started_at: z.number().finite().optional(),
})

/** 落库展示消息的结构：`role` 与 `timestamp` 必填，正文、卡片、来源、meta 依消息种类可缺省。 */
const displayMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  cards: z.array(cardSchema).optional(),
  sections: z.json().optional(),
  source: z.string().optional(),
  meta: messageMetaSchema.optional(),
  timestamp: z.number().finite(),
})

/** `agent_task_executions` 单行的校验 schema；列清单见 `task-sql.ts` 的 EXECUTION_COLUMNS。 */
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

/** 列表联表查询的单行结构：任务本体外附会话标题与 `latest_*` 一组最近执行字段。 */
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

/** 视图状态单行结构；`seen_at`/`collapsed_override`/`updated_at` 为 NULL 均表示用户未设置。 */
const viewStateRowSchema = z.object({
  execution_id: z.string(),
  seen_at: nullableDateSchema,
  collapsed_override: z.boolean().nullable(),
  updated_at: nullableDateSchema,
})

/** 只取 `retry_count` 的行 schema；重试路径只需要这一个字段，不必拉整行。 */
export const retryCountRowSchema = z.object({ retry_count: z.number().int().nonnegative() })
/** 键集分页游标的两段内容：创建时间与任务 ID，二者一起唯一确定下一页的边界。 */
interface TaskListCursor {
  /** 本页末条的创建时间；作为下一页 `created_at` 的上界。 */
  readonly createdAt: Date
  /** 本页末条的任务 ID；用于打破同一毫秒内多条记录的时间歧义。 */
  readonly taskId: string
}

/**
 * 键集分页游标：`created_at` 与 `task_id` 一起编码，避免同一毫秒内建的任务在翻页时被跳过或重复。
 *
 * @param createdAt - 本页末条的创建时间，作为下一页的时间上界。
 * @param taskId - 本页末条的任务 ID，与时间一起打破同毫秒歧义。
 * @returns base64url 编码的游标串。
 */
export function encodeTaskListCursor(createdAt: Date, taskId: string): string {
  return Buffer.from(`${createdAt.toISOString()}\n${taskId}`, 'utf8').toString('base64url')
}

/**
 * 解码游标；空串与任何畸形输入都返回 `undefined`，由调用方决定回退语义（通常是取首页）。
 * 这里刻意不抛错：游标是客户端回传的数据，把它当作不可信输入处理，坏游标不该让整个列表 500。
 * `isCanonicalBase64Url` 用来挡掉「同一串字节的多种 base64 写法」，保证游标可比较。
 *
 * @param value - 客户端回传的游标串，内容不可信。
 * @returns 解析出的时间与任务 ID；空串、畸形或非规范编码时返回 `undefined`。
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

/**
 * 校验并映射单行 `scheduled_tasks`；schema 不匹配直接抛错，不做「尽力填默认值」的兜底。
 *
 * @param value - 数据库原始行；可空列在 NULL 时视为字段缺省而非 `null`。
 * @returns 领域任务定义；`run_at`/`next_run_at` 为 NULL 时对应字段整体缺省。
 */
export function mapScheduledTaskRow(value: unknown): AgentTaskDefinition {
  const parsed = scheduledTaskRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('定时任务行数据无效', { cause: parsed.error })
  return toTaskDefinition(parsed.data)
}

/**
 * 校验并映射单行 `agent_task_executions`；可空列经 `optionalField` 折叠成「字段缺失」而非 `null`。
 *
 * @param value - 数据库原始行；`started_at`/`completed_at` 等可空列在 NULL 时折叠为字段缺省。
 * @returns 领域执行记录；行数据不符 Schema 时抛错，不做兜底。
 */
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
 *
 * @param value - 数据库原始行；`latest_*` 一组字段要么全有、要么全无。
 * @returns 列表项；`latest_execution_id` 为 NULL 时不带摘要，半截摘要直接抛错。
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

/**
 * 映射已读/折叠偏好行；三个可空字段缺省即表示「用户未设置」，由前端按默认规则决定呈现。
 *
 * @param value - 数据库原始行；可空列在 NULL 时字段整体缺省而非 `null`。
 * @returns 视图状态领域对象；行数据不符 Schema 时抛错。
 */
export function mapViewStateRow(value: unknown): ExecutionViewState {
  const parsed = viewStateRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('任务视图状态行数据非法', { cause: parsed.error })
  return {
    executionId: parsed.data.execution_id,
    ...optionalField('seenAt', parsed.data.seen_at),
    ...optionalField('collapsedOverride', parsed.data.collapsed_override),
    ...optionalField('updatedAt', parsed.data.updated_at),
  }
}
/**
 * 把已校验的 `scheduled_tasks` 行投影成领域任务定义：列名 snake_case → 字段 camelCase，
 * 可空时间列的 NULL 折叠成字段缺省，`schedule_type` 为空时回退到 `is_recurring` 布尔。
 *
 * @param row - 已通过 scheduledTaskRowSchema 校验的原始行。
 * @returns 领域任务定义。
 */
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

/**
 * 把已校验的展示消息行投影成领域消息：所有可缺省字段经 `optionalField` 折叠为字段缺失而非 `null`。
 *
 * @param row - 已通过 displayMessageSchema 校验的原始行。
 * @returns 领域展示消息。
 */
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

/**
 * 把已校验的卡片行投影成领域卡片；`data` 原样透传，不在映射层二次校验。
 *
 * @param row - 已通过 cardSchema 校验的原始行。
 * @returns 领域卡片。
 */
function toCard(row: z.infer<typeof cardSchema>): Card {
  return { type: row.type, data: row.data }
}

/**
 * 把已校验的消息 meta 行投影成领域 meta：定时任务来源缺失时不带该字段。
 *
 * @param row - 已通过 messageMetaSchema 校验的原始行。
 * @returns 领域消息 meta。
 */
function toMessageMeta(row: z.infer<typeof messageMetaSchema>): MessageMeta {
  return {
    ...optionalField(
      'scheduledTask',
      row.scheduled_task === undefined ? undefined : toScheduledTaskMeta(row.scheduled_task)
    ),
    ...optionalField('runStartedAt', row.run_started_at),
  }
}
/**
 * 只校验不映射，供需要读到原始列（如算游标用的 `created_at`）的调用点使用。
 *
 * @param value - 数据库原始行；形状不可信，先过列表行 Schema。
 * @returns 通过校验的原始行；不符 Schema 时抛错。
 */
export function parseTaskListRow(value: unknown): z.infer<typeof taskListRowSchema> {
  const parsed = taskListRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('任务列表行数据无效', { cause: parsed.error })
  return parsed.data
}

/**
 * 任务分页：多取一行来判断是否存在下页，再截断到 `limit`。
 * 游标取自截断后最后一行的 `created_at`——用被丢弃的那一行会让下一页从错误的边界开始。
 * 空串游标表示没有下页，这是分页约定的终止值。
 *
 * @param rows - 数据库原始行，约定长度为 `limit + 1`。
 * @param limit - 本页最大条数。
 * @param mapper - 行到领域对象的映射器，只为截断后的行各调用一次。
 * @returns 本页任务定义与下一页游标；无下页时游标为空串。
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

/**
 * 执行记录分页；与 `taskPage` 同为「多取一行」策略，但整页先全量校验再映射，坏行不会被静默跳过。
 *
 * @param rows - 数据库原始行，约定长度为 `limit + 1`；任一行非法即抛错。
 * @param limit - 本页最大条数。
 * @returns 本页执行记录与下一页游标；无下页时游标为空串。
 */
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

/**
 * 校验单条执行记录行；任一行非法即抛错，坏行不会被静默跳过。
 *
 * @param row - 数据库原始行；形状不可信，先过执行记录 Schema。
 * @returns 通过校验的原始行；不符 Schema 时抛错。
 */
function parseExecutionRow(row: unknown): z.infer<typeof executionRowSchema> {
  const result = executionRowSchema.safeParse(row)
  if (!result.success) throw new Error('执行记录行数据无效', { cause: result.error })
  return result.data
}

/**
 * 截断可空文本：NULL 映射为 `undefined`（字段缺省），其余按码点截断并追加省略号，
 * 保证列表接口不被单条超长文本撑大。
 *
 * @param value - 待截断的文本；null 表示该列缺省。
 * @param maxLength - 保留的最大码点数。
 * @returns 截断后的文本；输入为 null 时返回 `undefined`。
 */
function truncateOptionalText(value: string | null, maxLength: number): string | undefined {
  return value === null ? undefined : truncateCodePoints(value, maxLength)
}
/**
 * 判定游标串是否为该字节内容的规范 base64url 编码，挡掉「同一串字节的多种写法」，
 * 保证游标可直接按字符串比较。
 *
 * @param encoded - 客户端回传的原始游标串。
 * @param decoded - 由该串解码出的明文字符串。
 * @returns 以同一编码重新编码后与原串一致时为 true。
 */
function isCanonicalBase64Url(encoded: string, decoded: string): boolean {
  return Buffer.from(decoded, 'utf8').toString('base64url') === encoded
}

/**
 * schedule_type 为空是历史写入的兼容回退：旧实现只维护 is_recurring 布尔。
 *
 * @param scheduleType - 行里的 schedule_type；空串表示旧数据缺该列。
 * @param isRecurring - 旧布尔列；仅在 scheduleType 为空时作为回退判据。
 * @returns 归一后的调度类型，非空时原样返回 scheduleType。
 */
function taskScheduleType(
  scheduleType: '' | 'once' | 'recurring',
  isRecurring: boolean
): 'once' | 'recurring' {
  return scheduleType === '' ? (isRecurring ? 'recurring' : 'once') : scheduleType
}

/**
 * 展示消息中的定时任务来源信息；字段名从行快照映射到产品模型。
 *
 * @param row - 已通过 scheduledTaskMetaSchema 校验的原始行。
 * @returns 领域侧的定时任务来源信息。
 */
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
