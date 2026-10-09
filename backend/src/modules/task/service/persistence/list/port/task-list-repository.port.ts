import type { AgentTaskListItem, TaskPage } from './../../../../model/task.js'

/**
 * Task 列表专用只读投影；允许跨 Task 与 Session 表做只读 JOIN。
 * 默认实现为 `PostgresTaskListReadModel`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 并经 `app/composition-root.ts` 注入查询用例；该 Adapter 是 Task 与 Session 标题 JOIN 的唯一位置。
 */
export interface TaskListRepository {
  listItemsByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskListItem>>
  listItemsBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskListItem[]>
}
