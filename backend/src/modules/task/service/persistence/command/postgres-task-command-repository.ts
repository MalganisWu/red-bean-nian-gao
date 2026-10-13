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

  /**
   * 认领任务执行权：单调推进 fencing token，只有 token 更大的一方写入才算数。
   * 更新影响行数为 0 说明已被更新的 token 接管，抛 STALE_EXECUTION。
   *
   * @param taskId - 目标任务标识。
   * @param fencingToken - 本次认领的租约 token，必须严格大于库中现值才生效。
   * @param signal - 取消信号，透传到库查询。
   */
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

  /**
   * 新建任务行；`is_active` 恒为 TRUE、`retry_count` 归零，初始值由本函数而非调用方决定。
   *
   * @param task - 待落库的任务定义；`cronExpr` 为空串时统一存 NULL。
   * @param signal - 取消信号，透传到库查询。
   */
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

  /**
   * 更新任务的内容与调度字段；`WHERE` 同时按 session 与 user 过滤，越权即视为不存在。
   *
   * @param task - 目标任务，需带齐 taskId/sessionId/userId 供谓词匹配。
   * @param signal - 取消信号，透传到库查询。
   */
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

  /**
   * 更新任务的启停、重试计数与下次运行时间。
   * 不带 `fencingToken` 时按 taskId 无条件更新；带了则要求 token 仍相等，
   * 防止 lease 已被他人接管的实例覆盖新状态。
   *
   * @param task - 目标任务；只取 isActive/retryCount/nextRunAt 三字段。
   * @param signal - 取消信号，透传到库查询。
   * @param fencingToken - 租约 token；给出时以 token 相等为条件，不匹配抛 STALE_EXECUTION。
   */
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

  /**
   * 在一个事务里更新任务行并写入执行记录；任一步失败整体回滚，状态与记录不会只落一半。
   *
   * @param task - 任务更新值；重试计数与下次运行时间在此一并落库。
   * @param execution - 待写入的执行记录；展示消息先经 Presenter 转 wire 形状。
   * @param signal - 取消信号，透传到事务。
   * @param fencingToken - 租约 token；给出时任务行更新以 token 相等为条件，不匹配抛 STALE_EXECUTION。
   */
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

  /**
   * 软删除：只把任务置为非活跃，保留行供执行历史引用；删不到行说明不存在或非本人。
   *
   * @param userId - 任务所有者，直接进 `WHERE` 谓词做归属校验。
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到库查询。
   */
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
