import type { ExecutionViewState } from './../../../../model/task.js'

/**
 * 用户独立的任务执行阅读状态持久化边界。
 * 默认实现为 `PostgresExecutionViewStateRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 再经 `app/composition-root.ts` 注入 Task 查询与命令用例；查询和写入都必须保持用户所有权约束。
 */
export interface ExecutionViewStateRepository {
  /**
   * 批量读取执行记录的阅读状态；只返回属于该用户的记录，未设置过的执行不会出现。
   *
   * @param userId - 当前登录用户，作为归属过滤条件。
   * @param executionIds - 目标执行 ID 列表；调用方需已完成去重与数量上限校验。
   * @param signal - 取消信号，透传到库查询。
   * @returns 命中的视图状态；无则为空数组。
   */
  listExecutionViewStates(
    userId: string,
    executionIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly ExecutionViewState[]>

  /**
   * 写入或更新一条阅读状态：按用户与执行 ID 唯一键 upsert。
   *
   * @param userId - 当前登录用户，作为唯一键的一半。
   * @param executionId - 目标执行记录标识，作为唯一键的另一半。
   * @param markSeen - 是否推进已读时间；false 表示不动 seen_at。
   * @param collapsedOverride - 折叠覆盖值；undefined 表示不覆盖该列。
   * @param signal - 取消信号，透传到库查询。
   * @returns upsert 后的完整视图状态。
   */
  upsertExecutionViewState(
    userId: string,
    executionId: string,
    markSeen: boolean,
    collapsedOverride: boolean | undefined,
    signal: AbortSignal
  ): Promise<ExecutionViewState>
}
