import type { SqlExecutor } from './../../../../infra/database/postgres.js'
import { contextualError } from './../error/contextual-error.js'
import { toTaskDisplayMessageDto } from './task-display-message-presenter.js'
import {
  TASK_REPOSITORY_ERROR_CODES,
  TaskRepositoryError,
  type AgentTaskExecution,
} from './../../model/task.js'

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

interface SerializedExecution {
  readonly execution: AgentTaskExecution
  readonly displayMessages: string
}

export function serializeExecution(execution: AgentTaskExecution): SerializedExecution {
  return {
    execution,
    displayMessages: JSON.stringify(execution.displayMessages.map(toTaskDisplayMessageDto)),
  }
}

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

export function emptyStringToNull(value: string): string | null {
  return value === '' ? null : value
}

export function requirePositiveLimit(limit: number, context: string): void {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`${context}: limit 必须大于 0`)
}

export function notAuthorizedError(): TaskRepositoryError {
  return new TaskRepositoryError(TASK_REPOSITORY_ERROR_CODES.NOT_AUTHORIZED, '任务不存在或无权操作')
}

export function staleExecutionError(): TaskRepositoryError {
  return new TaskRepositoryError(TASK_REPOSITORY_ERROR_CODES.STALE_EXECUTION, '任务执行租约已失效')
}

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
