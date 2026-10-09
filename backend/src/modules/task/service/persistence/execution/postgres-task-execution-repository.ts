import { contextualError } from './../../error/contextual-error.js'
import type { TransactionalSqlExecutor } from './../../../../../infra/database/postgres.js'
import type { AgentTaskExecution } from './../../../model/task.js'
import type { TaskExecutionRepository } from './port/task-execution-repository.port.js'
import { mapExecutionRow } from './../task-row-mapper.js'
import { EXECUTION_COLUMNS } from './../task-sql.js'

/** PostgreSQL Task Execution 仓储；独占执行记录和投递确认。 */
export class PostgresTaskExecutionRepository implements TaskExecutionRepository {
  readonly #database: TransactionalSqlExecutor
  public constructor(database: TransactionalSqlExecutor) {
    this.#database = database
  }

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
