import type { AgentTaskDefinition } from './../../../model/task.js'

/** 定时任务管理工具使用的写边界；PostgreSQL 默认实现由 `task.module.ts` 组装后注入工具 Provider。 */
export interface ScheduledTaskManagementCommandRepository {
  createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>
  updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>
  softDeleteTask(userId: string, taskId: string, signal: AbortSignal): Promise<void>
}

/**
 * 定时任务管理工具使用的读边界；查询必须保持用户与 Session 所有权约束。
 * 默认实现为 `PostgresTaskQueryRepository`，由 `task.module.ts` 创建后注入 Tool Provider。
 */
export interface ScheduledTaskManagementQueryRepository {
  getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition>
  listBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]>
}

/** 工具 Provider 接收的最小 Task Repository 组合。 */
export interface ScheduledTaskManagementRepositories {
  readonly commands: ScheduledTaskManagementCommandRepository
  readonly queries: ScheduledTaskManagementQueryRepository
}
