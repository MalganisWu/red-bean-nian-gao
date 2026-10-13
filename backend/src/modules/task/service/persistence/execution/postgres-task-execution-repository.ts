import { contextualError } from './../../error/contextual-error.js'
import type { TransactionalSqlExecutor } from './../../../../../infra/database/postgres.js'
import type { AgentTaskExecution } from './../../../model/task.js'
import type { TaskExecutionRepository } from './port/task-execution-repository.port.js'
import { mapExecutionRow } from './../task-row-mapper.js'
import { EXECUTION_COLUMNS } from './../task-sql.js'

/** PostgreSQL Task Execution 仓储；独占执行记录和投递确认。 */
export class PostgresTaskExecutionRepository implements TaskExecutionRepository {
  /** 支持事务的 SQL 执行器；投递确认与未投递扫描都经它查询。 */
  readonly #database: TransactionalSqlExecutor
  public constructor(database: TransactionalSqlExecutor) {
    this.#database = database
  }

  /**
   * 把执行记录标记为已投递；只翻转尚未投递的行，因此天然幂等。
   *
   * @param executionId - 目标执行记录标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 本次是否真的发生了翻转；重复投递拿到 `false`。
   */
  public async markExecutionDelivered(executionId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.#database.query(
        `UPDATE agent_task_executions SET delivered = TRUE
         WHERE execution_id = $1 AND delivered = FALSE`,
        [executionId],
        signal
      )
      return result.rowCount > 0
    } catch (cause: unknown) {
      throw contextualError('标记执行记录已投递失败', cause)
    }
  }

  /**
   * 列出尚未标记投递的执行记录，按创建时间升序，供对账补投。
   *
   * @param sessionId - 限定会话；空串表示不限会话，返回全局未投递记录。
   * @param signal - 取消信号，透传到库查询。
   * @returns 未投递的执行记录；任一行不符 Schema 时抛出，不静默跳过。
   */
  public async listUndeliveredExecutions(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskExecution[]> {
    try {
      const sessionClause = sessionId === '' ? '' : 'AND session_id = $1'
      const parameters: readonly unknown[] = sessionId === '' ? [] : [sessionId]
      const result = await this.#database.query(
        `SELECT ${EXECUTION_COLUMNS}
         FROM agent_task_executions
         WHERE delivered = FALSE ${sessionClause}
         ORDER BY created_at ASC`,
        parameters,
        signal
      )
      return result.rows.map((row: unknown): AgentTaskExecution => mapExecutionRow(row))
    } catch (cause: unknown) {
      throw contextualError('查询未投递执行记录失败', cause)
    }
  }
}
