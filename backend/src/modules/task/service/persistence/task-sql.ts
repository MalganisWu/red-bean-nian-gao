import type { SqlExecutor } from './../../../../infra/database/postgres.js'
import { contextualError } from './../error/contextual-error.js'
import { toTaskDisplayMessageDto } from './task-display-message-presenter.js'
import {
  TASK_REPOSITORY_ERROR_CODES,
  TaskRepositoryError,
  type AgentTaskExecution,
} from './../../model/task.js'

/** `scheduled_tasks` 的列清单，供 SELECT 拼接；增删列时需同步 `scheduledTaskRowSchema`。 */
export const TASK_COLUMNS = `
  scheduled_task_id,
  session_id,
  user_id,
  task_input,
  schedule_type,
  run_at,
  cron_expr,
  next_run_at,
  is_active,
  retry_count,
  is_recurring,
  created_at
`

/** `agent_task_executions` 的列清单，供 SELECT 拼接；增删列时需同步 `executionRowSchema`。 */
export const EXECUTION_COLUMNS = `
  execution_id,
  task_id,
  session_id,
  status,
  scheduled_at,
  started_at,
  completed_at,
  display_messages,
  result_type,
  result_message,
  error_message,
  delivered,
  created_at
`

/**
 * 任务列表查询：一次取回任务本体、会话标题与最近一次执行摘要。
 * `session_title` 取该会话首条非空 user 消息——列表要的是「这个任务在聊什么」，
 * 用最新一条会让标题随着对话推进不断变化。`latest` 用 `LEFT JOIN LATERAL` 只为每行取一条，
 * 避免为取摘要再发一轮查询。
 */
export const TASK_LIST_SELECT = `
  SELECT
    task.scheduled_task_id,
    task.session_id,
    task.user_id,
    task.task_input,
    task.schedule_type,
    task.run_at,
    task.cron_expr,
    task.next_run_at,
    task.is_active,
    task.retry_count,
    task.is_recurring,
    task.created_at,
    COALESCE((
      SELECT message.value->>'content'
      FROM jsonb_array_elements(COALESCE(session.display_messages, '[]'::jsonb))
        WITH ORDINALITY AS message(value, ord)
      WHERE message.value->>'role' = 'user'
        AND NULLIF(BTRIM(message.value->>'content'), '') IS NOT NULL
      ORDER BY message.ord
      LIMIT 1
    ), '') AS session_title,
    latest.execution_id AS latest_execution_id,
    latest.status AS latest_status,
    latest.scheduled_at AS latest_scheduled_at,
    latest.started_at AS latest_started_at,
    latest.completed_at AS latest_completed_at,
    LEFT(latest.result_message, 256) AS latest_result_message,
    LEFT(latest.error_message, 256) AS latest_error_message
  FROM scheduled_tasks AS task
  LEFT JOIN sessions AS session
    ON session.session_id = task.session_id AND session.user_id = task.user_id
  LEFT JOIN LATERAL (
    SELECT execution_id, status, scheduled_at, started_at, completed_at,
      result_message, error_message
    FROM agent_task_executions
    WHERE task_id = task.scheduled_task_id
    ORDER BY created_at DESC, execution_id DESC
    LIMIT 1
  ) AS latest ON TRUE
`

/** 执行记录的落库形态；由 `serializeExecution` 产出，`insertExecution` 消费。 */
export interface SerializedExecution {
  /** 原始领域执行记录；展示消息之外的可空字段插入时统一转 NULL。 */
  readonly execution: AgentTaskExecution
  /** 经 Presenter 转 DTO 后再序列化的展示消息 JSON，落库为 `jsonb`。 */
  readonly displayMessages: string
}

/**
 * 把领域执行记录转成落库形态。
 * 展示消息必须**先经 Presenter 转成 DTO 再序列化**，不能直接 `JSON.stringify(execution)`：
 * 落库的是 wire 形状的快照，读取方（列表与导出）依赖这个稳定的字段约定。
 *
 * @param execution - 领域执行记录；展示消息须经 Presenter 转 DTO，不能整体 JSON 序列化。
 * @returns 原执行记录与已序列化的展示消息 JSON 两件套。
 */
export function serializeExecution(execution: AgentTaskExecution): SerializedExecution {
  return {
    execution,
    displayMessages: JSON.stringify(execution.displayMessages.map(toTaskDisplayMessageDto)),
  }
}

/**
 * 向 `agent_task_executions` 插入一条执行记录；可空字段以 NULL 落库。
 * 调用方需保证同一 execution_id 不会被重复插入。
 *
 * @param database - 目标 SQL 执行器，可以是事务内的执行器。
 * @param serialized - `serializeExecution` 产出的落库形态。
 * @param signal - 取消信号，透传到库查询。
 */
export async function insertExecution(
  database: SqlExecutor,
  serialized: SerializedExecution,
  signal: AbortSignal
): Promise<void> {
  const execution = serialized.execution
  await database.query(
    `INSERT INTO agent_task_executions (
      execution_id, task_id, session_id, status, scheduled_at, started_at,
      completed_at, display_messages, result_type,
      result_message, error_message, delivered
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12
    )`,
    [
      execution.executionId,
      execution.taskId,
      execution.sessionId,
      execution.status,
      execution.scheduledAt,
      execution.startedAt ?? null,
      execution.completedAt ?? null,
      serialized.displayMessages,
      execution.resultType ?? null,
      execution.resultMessage ?? null,
      execution.errorMessage ?? null,
      execution.delivered,
    ],
    signal
  )
}

/**
 * 空串在库里统一存 NULL，避免「空串」与「未设置」两种表示并存导致查询条件要写两遍。
 *
 * @param value - 待转换文本；空串转 NULL，其余原样返回。
 * @returns 空串对应 `null`，否则原值。
 */
export function emptyStringToNull(value: string): string | null {
  return value === '' ? null : value
}

/**
 * 分页 limit 的前置校验；`context` 会进错误信息，用来定位是哪个查询传了非法值。
 *
 * @param limit - 待校验的页大小，必须为正整数。
 * @param context - 调用点标签，仅用于错误信息定位。
 */
export function requirePositiveLimit(limit: number, context: string): void {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`${context}: limit 必须大于 0`)
}

/**
 * 「任务不存在」与「无权操作」共用一个错误码，使调用方无法靠错误差异探测他人任务是否存在。
 *
 * @returns NOT_AUTHORIZED 仓储错误。
 */
export function notAuthorizedError(): TaskRepositoryError {
  return new TaskRepositoryError(TASK_REPOSITORY_ERROR_CODES.NOT_AUTHORIZED, '任务不存在或无权操作')
}

/**
 * 执行租约已失效：说明另一个调度者已接手这次执行，本次写入应当放弃而不是覆盖。
 *
 * @returns STALE_EXECUTION 仓储错误。
 */
export function staleExecutionError(): TaskRepositoryError {
  return new TaskRepositoryError(TASK_REPOSITORY_ERROR_CODES.STALE_EXECUTION, '任务执行租约已失效')
}

/**
 * 给解析失败补上调用点上下文；否则行数据校验错误在日志里看不出是哪个查询产生的。
 *
 * @param value - 待解析的原始值，通常是数据库行。
 * @param parser - 解析器；抛错时被包上上下文再上抛。
 * @param context - 调用点标签，仅用于错误信息定位。
 * @returns 解析成功的结果；解析失败时抛出带上下文的错误。
 */
export function parseWithContext<TValue>(
  value: unknown,
  parser: (input: unknown) => TValue,
  context: string
): TValue {
  try {
    return parser(value)
  } catch (cause: unknown) {
    throw contextualError(context, cause)
  }
}
