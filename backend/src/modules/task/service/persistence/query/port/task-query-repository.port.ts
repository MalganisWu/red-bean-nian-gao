import type { AgentTaskDefinition, AgentTaskExecution, TaskPage } from './../../../../model/task.js'

/**
 * Task 定义与执行历史的读取边界。
 * 默认实现为 `PostgresTaskQueryRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * 再经 `app/composition-root.ts` 注入查询、调度和执行用例；业务所有权判断仍由对应 Application Service 负责。
 */
export interface TaskQueryRepository {
  /**
   * 按 ID 读取任务定义；不存在时由实现抛 NOT_FOUND 仓储错误，而非返回 undefined。
   *
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 任务定义；缺失即抛错。
   */
  getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition>

  /**
   * 按用户对任务定义做键集分页。
   *
   * @param userId - 当前登录用户，决定可见范围。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数，须为正整数。
   * @param signal - 取消信号，透传到库查询。
   * @returns 本页任务定义与下一页游标。
   */
  listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskDefinition>>

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

  /**
   * 分页读取某任务的执行历史，按时间倒序。
   *
   * @param taskId - 目标任务标识。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数，须为正整数。
   * @param signal - 取消信号，透传到库查询。
   * @returns 本页执行记录与下一页游标。
   */
  listExecutions(
    taskId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskExecution>>

  /**
   * 按任务与执行 ID 读取单条执行记录；不存在时返回 undefined，由用例层决定映射。
   *
   * @param taskId - 目标任务标识。
   * @param executionId - 目标执行记录标识。
   * @param signal - 取消信号，透传到库查询。
   * @returns 执行记录；不存在时为 undefined。
   */
  getExecutionById(
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<AgentTaskExecution | undefined>
}
