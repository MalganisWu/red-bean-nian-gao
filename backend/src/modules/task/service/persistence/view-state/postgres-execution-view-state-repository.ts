import { contextualError } from './../../error/contextual-error.js'
import type { TransactionalSqlExecutor } from './../../../../../infra/database/postgres.js'
import { TaskRepositoryError, type ExecutionViewState } from './../../../model/task.js'
import type { ExecutionViewStateRepository } from './port/execution-view-state-repository.port.js'
import { mapViewStateRow } from './../task-row-mapper.js'
import { notAuthorizedError } from './../task-sql.js'

/** PostgreSQL 用户执行阅读状态仓储；所有写入都同时校验 Task 所有权。 */
export class PostgresExecutionViewStateRepository implements ExecutionViewStateRepository {
  /** 支持事务的 SQL 执行器；读与 upsert 都经它查询。 */
  readonly #database: TransactionalSqlExecutor
  /** 时钟注入点；已读时间与更新时间统一取它，保证同一 upsert 内时间一致。 */
  readonly #now: () => Date

  public constructor(database: TransactionalSqlExecutor, now: () => Date = (): Date => new Date()) {
    this.#database = database
    this.#now = now
  }

  /**
   * 批量取执行结果的视图状态；只返回属于该用户的执行记录，越权 ID 被静默过滤。
   *
   * @param userId - 当前登录用户，用于归属过滤。
   * @param executionIds - 目标执行 ID 列表；空列表直接返回空数组，不查库。
   * @param signal - 取消信号，透传到库查询。
   * @returns 命中的视图状态；未设置过的执行记录不会出现。
   */
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

  /**
   * upsert 单条视图状态：已读时间只置位不回退，折叠覆盖仅在显式给出时更新。
   * 写入选择受任务所有权约束，无匹配行时抛 NOT_AUTHORIZED。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param executionId - 目标执行记录标识。
   * @param markSeen - 是否标记已读；为 true 时写入当前时间，为 false 保留已有值。
   * @param collapsedOverride - 折叠覆盖值；`undefined` 表示本次不改动该列。
   * @param signal - 取消信号，透传到库查询。
   * @returns upsert 后的视图状态。
   */
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
