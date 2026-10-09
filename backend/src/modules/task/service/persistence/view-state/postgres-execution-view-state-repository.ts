import { contextualError } from './../../error/contextual-error.js'
import type { TransactionalSqlExecutor } from './../../../../../infra/database/postgres.js'
import { TaskRepositoryError, type ExecutionViewState } from './../../../model/task.js'
import type { ExecutionViewStateRepository } from './port/execution-view-state-repository.port.js'
import { mapViewStateRow } from './../task-row-mapper.js'
import { notAuthorizedError } from './../task-sql.js'

/** PostgreSQL 用户执行阅读状态仓储；所有写入都同时校验 Task 所有权。 */
export class PostgresExecutionViewStateRepository implements ExecutionViewStateRepository {
  readonly #database: TransactionalSqlExecutor
  readonly #now: () => Date

  public constructor(database: TransactionalSqlExecutor, now: () => Date = (): Date => new Date()) {
    this.#database = database
    this.#now = now
  }

  public async listExecutionViewStates(
    userId: string,
    executionIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly ExecutionViewState[]> {
    if (executionIds.length === 0) return []
    try {
      const result = await this.#database.query(
        `SELECT execution.execution_id, view_state.seen_at,
          view_state.collapsed_override, view_state.updated_at
         FROM agent_task_executions AS execution
         JOIN scheduled_tasks AS task ON task.scheduled_task_id = execution.task_id
         LEFT JOIN task_run_view_states AS view_state
           ON view_state.execution_id = execution.execution_id
          AND view_state.user_id = $1
         WHERE task.user_id = $1 AND execution.execution_id = ANY($2::text[])
         ORDER BY execution.created_at DESC`,
        [userId, [...new Set(executionIds)]],
        signal
      )
      return result.rows.map((row: unknown): ExecutionViewState => mapViewStateRow(row))
    } catch (cause: unknown) {
      throw contextualError('批量查询执行结果视图状态失败', cause)
    }
  }

  public async upsertExecutionViewState(
    userId: string,
    executionId: string,
    markSeen: boolean,
    collapsedOverride: boolean | undefined,
    signal: AbortSignal
  ): Promise<ExecutionViewState> {
    const now = this.#now()
    try {
      const result = await this.#database.query(
        `INSERT INTO task_run_view_states (
          user_id, execution_id, seen_at, collapsed_override, updated_at
        )
        SELECT $1::varchar(64), execution.execution_id, $2, $3, $4
        FROM agent_task_executions AS execution
        JOIN scheduled_tasks AS task ON task.scheduled_task_id = execution.task_id
        WHERE execution.execution_id = $5 AND task.user_id = $1::varchar(64)
        ON CONFLICT (user_id, execution_id) DO UPDATE SET
          seen_at = COALESCE(task_run_view_states.seen_at, EXCLUDED.seen_at),
          collapsed_override = CASE
            WHEN $6 THEN EXCLUDED.collapsed_override
            ELSE task_run_view_states.collapsed_override
          END,
          updated_at = EXCLUDED.updated_at
        RETURNING execution_id, seen_at, collapsed_override, updated_at`,
        [
          userId,
          markSeen ? now : null,
          collapsedOverride ?? null,
          now,
          executionId,
          collapsedOverride !== undefined,
        ],
        signal
      )
      const row = result.rows[0]
      if (row === undefined) throw notAuthorizedError()
      return mapViewStateRow(row)
    } catch (cause: unknown) {
      if (cause instanceof TaskRepositoryError) throw cause
      throw contextualError('更新执行结果视图状态失败', cause)
    }
  }
}
