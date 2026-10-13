import type { AgentTaskDefinition } from './../../../model/task.js'

/** 定时任务管理工具使用的写边界；PostgreSQL 默认实现由 `task.module.ts` 组装后注入工具 Provider。 */
export interface ScheduledTaskManagementCommandRepository {
  /**
   * 插入一条新任务；归属字段来自调用方校验过的 scope。
   *
   * @param task - 待落库的任务定义。
   * @param signal - 取消信号，透传到库查询。
   */
  createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>

  /**
   * 更新任务的提示词与调度字段；实现须以 session 与 user 谓词约束归属。
   *
   * @param task - 携带新内容与调度字段的任务定义。
   * @param signal - 取消信号，透传到库查询。
   */
  updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>

  /**
   * 软删除任务：只置停用标记，并以 user_id 谓词约束归属。
   *
   * @param userId - 当前登录用户，作为删除谓词的归属约束。
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到库查询。
   */
  softDeleteTask(userId: string, taskId: string, signal: AbortSignal): Promise<void>
}

/**
 * 定时任务管理工具使用的读边界；查询必须保持用户与 Session 所有权约束。
 * 默认实现为 `PostgresTaskQueryRepository`，由 `task.module.ts` 创建后注入 Tool Provider。
 */
export interface ScheduledTaskManagementQueryRepository {
  /**
   * 按 ID 读取任务定义；不存在时抛错，由工具层统一翻译成「任务不存在或无权操作」。
   *
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 任务定义；缺失即抛错。
   */
  getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition>

  /**
   * 列出某会话下的任务定义，并以用户谓词过滤，越权会话返回空列表。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 当前登录用户，作为归属过滤条件。
   * @param signal - 取消信号，透传到库查询。
   * @returns 该会话的任务定义集合；无则为空数组。
   */
  listBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]>
}

/** 工具 Provider 接收的最小 Task Repository 组合。 */
export interface ScheduledTaskManagementRepositories {
  /** 写边界；创建、更新内容与软删除三个方法。 */
  readonly commands: ScheduledTaskManagementCommandRepository
  /** 读边界；按 ID 读取与按会话列出两个方法。 */
  readonly queries: ScheduledTaskManagementQueryRepository
}
