import type { AgentTaskDefinition, AgentTaskExecution, TaskPage } from './../../../../model/task.js'

/**
 * Task 定义与执行历史的读取边界。
 * 默认实现为 `PostgresTaskQueryRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 再经 `app/composition-root.ts` 注入查询、调度和执行用例；业务所有权判断仍由对应 Application Service 负责。
 */
export interface TaskQueryRepository {
  getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition>
  listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskDefinition>>
  listBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]>
  listExecutions(
    taskId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskExecution>>
  getExecutionById(
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<AgentTaskExecution | undefined>
}
