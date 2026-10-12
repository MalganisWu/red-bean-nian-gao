import { contextualError } from './../../error/contextual-error.js'
import type {
  SqlExecutor,
  TransactionalSqlExecutor,
} from './../../../../../infra/database/postgres.js'
import {
  TaskRepositoryError,
  type AgentTaskDefinition,
  type AgentTaskExecution,
} from './../../../model/task.js'
import type { ScheduledTaskManagementCommandRepository } from './../../tool/port/scheduled-task-management-repository.port.js'
import type { TaskCommandRepository } from './port/task-command-repository.port.js'
import {
  emptyStringToNull,
  insertExecution,
  notAuthorizedError,
  type SerializedExecution,
  serializeExecution,
  staleExecutionError,
} from './../task-sql.js'

/** PostgreSQL Task 写模型；集中维护命令、事务与 fencing 条件。 */
export class PostgresTaskCommandRepository
  implements TaskCommandRepository, ScheduledTaskManagementCommandRepository
{
  readonly #database: TransactionalSqlExecutor
  readonly #now: () => Date

  public constructor(database: TransactionalSqlExecutor, now: () => Date = (): Date => new Date()) {
    this.#database = database
    this.#now = now
  }

  public async claimExecution(
    taskId: string,
    fencingToken: bigint,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const result = await this.#database.query(
        `UPDATE scheduled_tasks
         SET execution_fencing_token = $1, updated_at = $2
         WHERE scheduled_task_id = $3 AND execution_fencing_token < $1`,
        [fencingToken.toString(), this.#now(), taskId],
        signal
      )
      if (result.rowCount === 0) throw staleExecutionError()
    } catch (cause: unknown) {
      if (cause instanceof TaskRepositoryError) throw cause
      throw contextualError('认领任务执行权失败', cause)
    }
  }

  public async createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    try {
      await this.#database.query(
        `INSERT INTO scheduled_tasks (
          scheduled_task_id, session_id, user_id, task_input, schedule_type,
          run_at, cron_expr, next_run_at, is_active, retry_count, is_recurring
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, 0, $9)`,
        [
          task.taskId,
          task.sessionId,
          task.userId,
          task.taskInput,
          task.scheduleType,
          task.runAt ?? null,
          emptyStringToNull(task.cronExpr),
          task.nextRunAt ?? null,
          task.scheduleType === 'recurring',
        ],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError('创建任务失败', cause)
    }
  }

  public async updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.#database.query(
        `UPDATE scheduled_tasks SET
          task_input = $1, schedule_type = $2, run_at = $3, cron_expr = $4,
          next_run_at = $5, is_recurring = $6
         WHERE scheduled_task_id = $7 AND session_id = $8 AND user_id = $9`,
        [
          task.taskInput,
          task.scheduleType,
          task.runAt ?? null,
          emptyStringToNull(task.cronExpr),
          task.nextRunAt ?? null,
          task.scheduleType === 'recurring',
          task.taskId,
          task.sessionId,
          task.userId,
        ],
        signal
      )
      if (result.rowCount === 0) throw notAuthorizedError()
    } catch (cause: unknown) {
      if (cause instanceof TaskRepositoryError) throw cause
      throw contextualError('更新任务内容失败', cause)
    }
  }

  public async updateTask(
    task: AgentTaskDefinition,
    signal: AbortSignal,
    fencingToken?: bigint
  ): Promise<void> {
    try {
      const result = await this.#database.query(
        `UPDATE scheduled_tasks
         SET is_active = $1, retry_count = $2, next_run_at = $3
         WHERE scheduled_task_id = $4${fencingToken === undefined ? '' : ' AND execution_fencing_token = $5'}`,
        [
          task.isActive,
          task.retryCount,
          task.nextRunAt ?? null,
          task.taskId,
          ...(fencingToken === undefined ? [] : [fencingToken.toString()]),
        ],
        signal
      )
      if (fencingToken !== undefined && result.rowCount === 0) throw staleExecutionError()
    } catch (cause: unknown) {
      if (cause instanceof TaskRepositoryError) throw cause
      throw contextualError('更新任务失败', cause)
    }
  }

  public async saveExecutionWithTaskUpdate(
    task: AgentTaskDefinition,
    execution: AgentTaskExecution,
    signal: AbortSignal,
    fencingToken?: bigint
  ): Promise<void> {
    try {
      const serialized = serializeExecution(execution)
      await this.#database.transaction(signal, (transaction) =>
        updateTaskRowAndInsertExecution(transaction, task, serialized, fencingToken, signal)
      )
    } catch (cause: unknown) {
      if (cause instanceof TaskRepositoryError) throw cause
      throw contextualError('任务执行落库事务失败', cause)
    }
  }

  public async softDeleteTask(userId: string, taskId: string, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.#database.query(
        `UPDATE scheduled_tasks SET is_active = FALSE
         WHERE scheduled_task_id = $1 AND user_id = $2`,
        [taskId, userId],
        signal
      )
      if (result.rowCount === 0) throw notAuthorizedError()
    } catch (cause: unknown) {
      if (cause instanceof TaskRepositoryError) throw cause
      throw contextualError('软删除任务失败', cause)
    }
  }
}

/**
 * 事务内先按 fencing 条件更新任务行，再写入执行记录；
 * 任一步失败都让整个事务回滚，任务状态与执行记录不会只落一半。
 */
async function updateTaskRowAndInsertExecution(
  transaction: SqlExecutor,
  task: AgentTaskDefinition,
  serialized: SerializedExecution,
  fencingToken: bigint | undefined,
  signal: AbortSignal
): Promise<void> {
  const update = await transaction.query(
    `UPDATE scheduled_tasks
           SET is_active = $1, retry_count = $2, next_run_at = $3
           WHERE scheduled_task_id = $4${fencingToken === undefined ? '' : ' AND execution_fencing_token = $5'}`,
    [
      task.isActive,
      task.retryCount,
      task.nextRunAt ?? null,
      task.taskId,
      ...(fencingToken === undefined ? [] : [fencingToken.toString()]),
    ],
    signal
  )
  if (fencingToken !== undefined && update.rowCount === 0) throw staleExecutionError()
  await insertExecution(transaction, serialized, signal)
}
