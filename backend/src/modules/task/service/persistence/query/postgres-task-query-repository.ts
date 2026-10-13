import { contextualError } from './../../error/contextual-error.js'
import type { TransactionalSqlExecutor } from './../../../../../infra/database/postgres.js'
import {
  TASK_REPOSITORY_ERROR_CODES,
  TaskRepositoryError,
  type AgentTaskDefinition,
  type AgentTaskExecution,
  type TaskPage,
} from './../../../model/task.js'
import type { PendingTaskRepository } from './../../scheduling/port/task-scheduler.port.js'
import type { ScheduledTaskManagementQueryRepository } from './../../tool/port/scheduled-task-management-repository.port.js'
import type { TaskQueryRepository } from './port/task-query-repository.port.js'
import {
  executionPage,
  mapExecutionRow,
  mapScheduledTaskRow,
  taskPage,
} from './../task-row-mapper.js'
import {
  EXECUTION_COLUMNS,
  parseWithContext,
  requirePositiveLimit,
  TASK_COLUMNS,
} from './../task-sql.js'

/** PostgreSQL Task 读模型；负责定义、执行历史和 Scheduler 待办查询。 */
export class PostgresTaskQueryRepository
  implements TaskQueryRepository, PendingTaskRepository, ScheduledTaskManagementQueryRepository
{
  readonly #database: TransactionalSqlExecutor

  public constructor(database: TransactionalSqlExecutor) {
    this.#database = database
  }

  /**
   * 读取单个任务定义；查不到抛 NOT_FOUND，行数据不符 Schema 时抛错而非兜底。
   *
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 校验通过的任务定义。
   */
  public async getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition> {
    let result
    try {
      result = await this.#database.query(
        `SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE scheduled_task_id = $1`,
        [taskId],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError('查询任务失败', cause)
    }
    const row = result.rows[0]
    if (row === undefined) {
      throw new TaskRepositoryError(
        TASK_REPOSITORY_ERROR_CODES.NOT_FOUND,
        `任务 '${taskId}' 不存在`
      )
    }
    return parseWithContext(row, mapScheduledTaskRow, '查询任务失败')
  }

  /**
   * 取一批到期且活跃的任务，按 next_run_at 升序，供调度器单轮扫描。
   *
   * @param now - 判定到期的当前时刻。
   * @param limit - 本批最大条数；非正数在此即抛错。
   * @param signal - 取消信号，透传到库查询。
   * @returns 到期任务定义列表。
   */
  public async getPendingTasks(
    now: Date,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    requirePositiveLimit(limit, '查询待执行任务失败')
    try {
      const result = await this.#database.query(
        `SELECT ${TASK_COLUMNS}
         FROM scheduled_tasks
         WHERE is_active = TRUE AND next_run_at <= $1
         ORDER BY next_run_at ASC
         LIMIT $2`,
        [now, limit],
        signal
      )
      return result.rows.map((row: unknown): AgentTaskDefinition => mapScheduledTaskRow(row))
    } catch (cause: unknown) {
      throw contextualError('查询待执行任务失败', cause)
    }
  }

  /**
   * 按用户分页列出任务定义；分页用「多取一条」判 hasMore，游标是 `created_at` 上界。
   *
   * @param userId - 任务所有者，直接进 `WHERE` 谓词。
   * @param cursor - 上一页末条的时间戳游标；空串表示取首页。
   * @param limit - 本页最大条数；非正数在此即抛错。
   * @param signal - 取消信号，透传到库查询。
   * @returns 本页任务定义与下一页游标。
   */
  public async listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskDefinition>> {
    requirePositiveLimit(limit, '查询用户任务列表失败')
    try {
      const pagination = cursorPagination(userId, cursor, limit)
      const result = await this.#database.query(
        `SELECT ${TASK_COLUMNS}
         FROM scheduled_tasks
         WHERE user_id = $1 ${pagination.cursorClause}
         ORDER BY created_at DESC
         LIMIT ${pagination.limitIndex}`,
        pagination.parameters,
        signal
      )
      return taskPage(result.rows, limit, mapScheduledTaskRow)
    } catch (cause: unknown) {
      throw contextualError('查询用户任务列表失败', cause)
    }
  }

  /**
   * 列出某会话下的全部任务定义；同时按用户过滤，越权会话得到空列表。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 任务所有者，用于归属过滤。
   * @param signal - 取消信号，透传到库查询。
   * @returns 该会话的任务定义，按创建时间倒序。
   */
  public async listBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    try {
      const result = await this.#database.query(
        `SELECT ${TASK_COLUMNS}
         FROM scheduled_tasks
         WHERE session_id = $1 AND user_id = $2
         ORDER BY created_at DESC`,
        [sessionId, userId],
        signal
      )
      return result.rows.map((row: unknown): AgentTaskDefinition => mapScheduledTaskRow(row))
    } catch (cause: unknown) {
      throw contextualError('查询会话任务列表失败', cause)
    }
  }

  /**
   * 分页列出某任务的执行记录；整页先全量校验行再映射，坏行不会被静默跳过。
   *
   * @param taskId - 目标任务标识，直接进 `WHERE` 谓词。
   * @param cursor - 上一页末条的时间戳游标；空串表示取首页。
   * @param limit - 本页最大条数；非正数在此即抛错。
   * @param signal - 取消信号，透传到库查询。
   * @returns 本页执行记录与下一页游标。
   */
  public async listExecutions(
    taskId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskExecution>> {
    requirePositiveLimit(limit, '查询执行记录列表失败')
    try {
      const pagination = cursorPagination(taskId, cursor, limit)
      const result = await this.#database.query(
        `SELECT ${EXECUTION_COLUMNS}
         FROM agent_task_executions
         WHERE task_id = $1 ${pagination.cursorClause}
         ORDER BY created_at DESC
         LIMIT ${pagination.limitIndex}`,
        pagination.parameters,
        signal
      )
      return executionPage(result.rows, limit)
    } catch (cause: unknown) {
      throw contextualError('查询执行记录列表失败', cause)
    }
  }

  /**
   * 按任务与执行 ID 读取单条执行记录；查不到返回 `undefined` 而非抛错，
   * 由调用方自行决定「不存在」是错误还是正常分支。
   *
   * @param taskId - 目标任务标识，兼作跨任务读取的隔离条件。
   * @param executionId - 目标执行记录标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 目标执行记录；不存在时为 `undefined`。
   */
  public async getExecutionById(
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<AgentTaskExecution | undefined> {
    try {
      const result = await this.#database.query(
        `SELECT ${EXECUTION_COLUMNS}
         FROM agent_task_executions
         WHERE task_id = $1 AND execution_id = $2`,
        [taskId, executionId],
        signal
      )
      const row = result.rows[0]
      return row === undefined ? undefined : mapExecutionRow(row)
    } catch (cause: unknown) {
      throw contextualError('查询执行记录失败', cause)
    }
  }
}

/**
 * 组装"按 created_at 游标"分页的 SQL 片段与绑定参数。
 * 有游标时在 owner 参数后追加游标并启用 created_at 上界；无游标退化为纯 limit 查询。
 * 每页多取一条用于 hasMore 判定，具体分页逻辑由下游 `taskPage`/`executionPage` 处理。
 */
function cursorPagination(
  owner: string,
  cursor: string,
  limit: number
): {
  readonly cursorClause: string
  readonly limitIndex: string
  readonly parameters: readonly unknown[]
} {
  if (cursor === '') {
    return { cursorClause: '', limitIndex: '$2', parameters: [owner, limit + 1] }
  }
  return {
    cursorClause: 'AND created_at < $2::timestamptz',
    limitIndex: '$3',
    parameters: [owner, cursor, limit + 1],
  }
}
