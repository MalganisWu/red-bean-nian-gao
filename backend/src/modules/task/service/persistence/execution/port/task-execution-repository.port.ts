import type { AgentTaskExecution } from './../../../../model/task.js'

/**
 * 调度执行记录与投递确认的持久化边界。
 * 默认实现为 `PostgresTaskExecutionRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 再经 `app/composition-root.ts` 注入 Task Module。Task Module 拥有执行状态与投递确认，调用方不得自行拼接持久化状态。
 */
export interface TaskExecutionRepository {
  /**
   * 标记执行记录已投递；投递是 at-least-once，返回 false 表示此前已标记、本次应视作重复投递跳过。
   *
   * @param executionId - 目标执行记录标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 本次是否真正翻转到「已投递」；false 表示已被抢先标记。
   */
  markExecutionDelivered(executionId: string, signal: AbortSignal): Promise<boolean>

  /**
   * 列出某会话下尚未投递的执行记录，供投递补偿扫描使用。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 未投递的执行记录集合；无则为空数组。
   */
  listUndeliveredExecutions(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskExecution[]>
}
