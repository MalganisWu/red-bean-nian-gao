import type { AgentTaskExecution } from './../../../../model/task.js'

/**
 * 调度执行记录与投递确认的持久化边界。
 * 默认实现为 `PostgresTaskExecutionRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 再经 `app/composition-root.ts` 注入 Task Module。Task Module 拥有执行状态与投递确认，调用方不得自行拼接持久化状态。
 */
export interface TaskExecutionRepository {
  markExecutionDelivered(executionId: string, signal: AbortSignal): Promise<boolean>
  listUndeliveredExecutions(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskExecution[]>
}
