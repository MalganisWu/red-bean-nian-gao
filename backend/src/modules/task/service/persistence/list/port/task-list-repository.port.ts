import type { AgentTaskListItem, TaskPage } from './../../../../model/task.js'

/**
 * Task 列表专用只读投影；允许跨 Task 与 Session 表做只读 JOIN。
 * 默认实现为 `PostgresTaskListReadModel`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 并经 `app/composition-root.ts` 注入查询用例；该 Adapter 是 Task 与 Session 标题 JOIN 的唯一位置。
 */
export interface TaskListRepository {
  /**
   * 按用户做键集分页，一次取回列表项与附带的会话标题、最近执行摘要。
   *
   * @param userId - 当前登录用户，决定可见范围。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数，须为正整数。
   * @param signal - 取消信号，透传到库查询。
   * @returns 本页列表项与下一页游标；末页 nextCursor 为空串。
   */
  listItemsByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskListItem>>

  /**
   * 列出某会话下的全部任务列表项，并以用户谓词过滤，越权会话返回空列表。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 当前登录用户，作为归属过滤条件。
   * @param signal - 取消信号，透传到库查询。
   * @returns 该会话的列表项集合；无则为空数组。
   */
  listItemsBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskListItem[]>
}
