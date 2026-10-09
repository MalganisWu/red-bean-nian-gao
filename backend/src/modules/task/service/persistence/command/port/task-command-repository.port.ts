import type { AgentTaskDefinition, AgentTaskExecution } from './../../../../model/task.js'

/**
 * Task 写模型与执行 fencing 的持久化边界。
 * 默认实现为 `PostgresTaskCommandRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * `app/composition-root.ts` 在平台工具注册前调用该工厂。Adapter 拥有事务与 fencing 原子性，调用用例负责业务授权。
 */
export interface TaskCommandRepository {
  claimExecution(taskId: string, fencingToken: bigint, signal: AbortSignal): Promise<void>
  createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>
  updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>
  updateTask(task: AgentTaskDefinition, signal: AbortSignal, fencingToken?: bigint): Promise<void>
  saveExecutionWithTaskUpdate(
    task: AgentTaskDefinition,
    execution: AgentTaskExecution,
    signal: AbortSignal,
    fencingToken?: bigint
  ): Promise<void>
  softDeleteTask(userId: string, taskId: string, signal: AbortSignal): Promise<void>
}
