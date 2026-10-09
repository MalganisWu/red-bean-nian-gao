import type { ExecutionViewState } from './../../../../model/task.js'

/**
 * 用户独立的任务执行阅读状态持久化边界。
 * 默认实现为 `PostgresExecutionViewStateRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 再经 `app/composition-root.ts` 注入 Task 查询与命令用例；查询和写入都必须保持用户所有权约束。
 */
export interface ExecutionViewStateRepository {
  listExecutionViewStates(
    userId: string,
    executionIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly ExecutionViewState[]>
  upsertExecutionViewState(
    userId: string,
    executionId: string,
    markSeen: boolean,
    collapsedOverride: boolean | undefined,
    signal: AbortSignal
  ): Promise<ExecutionViewState>
}
