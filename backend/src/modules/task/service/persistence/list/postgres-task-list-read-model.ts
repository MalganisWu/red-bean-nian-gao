import { contextualError } from './../../error/contextual-error.js'
import type { TransactionalSqlExecutor } from './../../../../../infra/database/postgres.js'
import type { AgentTaskListItem, TaskPage } from './../../../model/task.js'
import type { TaskListRepository } from './port/task-list-repository.port.js'
import {
  decodeTaskListCursor,
  encodeTaskListCursor,
  mapTaskListRow,
  parseTaskListRow,
} from './../task-row-mapper.js'
import { requirePositiveLimit, TASK_LIST_SELECT } from './../task-sql.js'

/** PostgreSQL 任务列表只读模型；这里是 Task 与 Session 标题 JOIN 的唯一位置。 */
export class PostgresTaskListReadModel implements TaskListRepository {
  readonly #database: TransactionalSqlExecutor

  public constructor(database: TransactionalSqlExecutor) {
    this.#database = database
  }

  public async listItemsByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskListItem>> {
    requirePositiveLimit(limit, '查询用户任务列表聚合信息失败')
    try {
      const decoded = decodeTaskListCursor(cursor)
      let cursorClause = ''
      let parameters: readonly unknown[] = [userId, limit + 1]
      let limitIndex = '$2'
      if (decoded !== undefined) {
        cursorClause = `AND (
          task.created_at < $2 OR
          (task.created_at = $2 AND task.scheduled_task_id < $3)
        )`
        parameters = [userId, decoded.createdAt, decoded.taskId, limit + 1]
        limitIndex = '$4'
      } else if (cursor !== '') {
        cursorClause = 'AND task.created_at < $2::timestamptz'
        parameters = [userId, cursor, limit + 1]
        limitIndex = '$3'
      }
      const result = await this.#database.query(
        `${TASK_LIST_SELECT}
         WHERE task.user_id = $1 ${cursorClause}
         ORDER BY task.created_at DESC, task.scheduled_task_id DESC
         LIMIT ${limitIndex}`,
        parameters,
        signal
      )
      const rows = result.rows.map(parseTaskListRow)
      const hasMore = rows.length > limit
      const selected = hasMore ? rows.slice(0, limit) : rows
      const last = selected.at(-1)
      return {
        items: selected.map((row): AgentTaskListItem => mapTaskListRow(row)),
        nextCursor:
          hasMore && last !== undefined
            ? encodeTaskListCursor(last.created_at, last.scheduled_task_id)
            : '',
      }
    } catch (cause: unknown) {
      throw contextualError('查询用户任务列表聚合信息失败', cause)
    }
  }

  public async listItemsBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskListItem[]> {
    try {
      const result = await this.#database.query(
        `${TASK_LIST_SELECT}
         WHERE task.session_id = $1 AND task.user_id = $2
         ORDER BY task.created_at DESC, task.scheduled_task_id DESC`,
        [sessionId, userId],
        signal
      )
      return result.rows.map((row: unknown): AgentTaskListItem => mapTaskListRow(row))
    } catch (cause: unknown) {
      throw contextualError('查询会话任务列表聚合信息失败', cause)
    }
  }
}
