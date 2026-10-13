import type { AgentTaskDefinition, AgentTaskExecution } from './../../../../model/task.js'

/**
 * Task 写模型与执行 fencing 的持久化边界。
 * 默认实现为 `PostgresTaskCommandRepository`，由 `task.module.ts` 的 `createTaskPersistence()` 创建，
 * `app/composition-root.ts` 在平台工具注册前调用该工厂。Adapter 拥有事务与 fencing 原子性，调用用例负责业务授权。
 */
export interface TaskCommandRepository {
  /**
   * 抢占执行租约：以 fencingToken 单调递增地取得该任务的执行权，旧租约随之失效。
   *
   * @param taskId - 目标任务标识，作为租约的竞争键。
   * @param fencingToken - 本次抢占的围栏令牌；更新谓词据此拒绝更旧的写入。
   * @param signal - 取消信号，透传到库查询。
   */
  claimExecution(taskId: string, fencingToken: bigint, signal: AbortSignal): Promise<void>

  /**
   * 插入一条新的任务定义。
   *
   * @param task - 待落库的任务定义；身份字段由调用方保证唯一。
   * @param signal - 取消信号，透传到库查询。
   */
  createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>

  /**
   * 更新任务的提示词正文，用于平台工具改写定时任务的输入。
   *
   * @param task - 携带新 taskInput 的任务定义。
   * @param signal - 取消信号，透传到库查询。
   */
  updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void>

  /**
   * 更新任务的可变字段（启停、重试计数、下次执行时刻等）。
   *
   * @param task - 待落库的任务定义。
   * @param signal - 取消信号，透传到库查询。
   * @param fencingToken - 可选的围栏令牌；给出时写入须仍持有租约，否则拒绝。
   */
  updateTask(task: AgentTaskDefinition, signal: AbortSignal, fencingToken?: bigint): Promise<void>

  /**
   * 在同一事务内更新任务行并插入执行记录，保证「推进 nextRunAt」与「写入执行」原子提交。
   *
   * @param task - 与执行同事务更新的任务定义。
   * @param execution - 待插入的执行记录。
   * @param signal - 取消信号，透传到库查询。
   * @param fencingToken - 可选的围栏令牌；给出时事务须仍持有租约，否则拒绝。
   */
  saveExecutionWithTaskUpdate(
    task: AgentTaskDefinition,
    execution: AgentTaskExecution,
    signal: AbortSignal,
    fencingToken?: bigint
  ): Promise<void>

  /**
   * 软删除任务：只置停用标记，并以 user_id 谓词约束归属；不存在与越权共用同一错误。
   *
   * @param userId - 当前登录用户，作为删除谓词的归属约束。
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到库查询。
   */
  softDeleteTask(userId: string, taskId: string, signal: AbortSignal): Promise<void>
}
