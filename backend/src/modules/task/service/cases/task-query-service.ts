import {
  TASK_REPOSITORY_ERROR_CODES,
  TaskRepositoryError,
  type AgentTaskDefinition,
  type AgentTaskExecution,
  type AgentTaskListItem,
  type ExecutionViewState,
  type TaskPage,
} from './../../model/task.js'
import type { TaskListRepository } from './../persistence/list/port/task-list-repository.port.js'
import type { TaskQueryRepository } from './../persistence/query/port/task-query-repository.port.js'
import type { ExecutionViewStateRepository } from './../persistence/view-state/port/execution-view-state-repository.port.js'
import {
  TASK_APPLICATION_ERROR_CODES,
  TaskApplicationError,
  infrastructureFailure,
} from './../error/task-application-error.js'

/** 查询用例依赖：任务详情、任务列表与已读/折叠偏好三个仓储。 */
export interface TaskQueryServiceDependencies {
  /** 任务详情与执行记录仓储；详情、执行历史路径走它。 */
  readonly taskRepository: TaskQueryRepository
  /** 任务列表读模型；列表与会话任务路径走它，避免逐条回查。 */
  readonly taskListRepository: TaskListRepository
  /** 已读/折叠偏好仓储；仅用于批量读取视图状态。 */
  readonly viewStateRepository: ExecutionViewStateRepository
}

/** Task 查询用例默认实现：集中处理资源所有权与 Repository 失败语义。 */
export class TaskQueryService {
  /** 查询用例依赖；由构造器注入，服务本身不创建仓储。 */
  readonly #dependencies: TaskQueryServiceDependencies

  public constructor(dependencies: TaskQueryServiceDependencies) {
    this.#dependencies = dependencies
  }

  /**
   * 按用户分页列出任务列表项；查询失败统一翻译为基础设施失败。
   *
   * @param userId - 当前登录用户，决定可见范围。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数。
   * @param signal - 取消信号，透传到仓储。
   * @returns 本页列表项与下一页游标。
   */
  public async listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskListItem>> {
    try {
      return await this.#dependencies.taskListRepository.listItemsByUser(
        userId,
        cursor,
        limit,
        signal
      )
    } catch (cause: unknown) {
      throw infrastructureFailure('查询任务列表失败', cause)
    }
  }

  /**
   * 批量取执行结果的视图状态；只返回属于该用户的执行记录。
   *
   * @param userId - 当前登录用户，用于归属过滤。
   * @param executionIds - 目标执行 ID 列表；空列表直接返回空数组，不查库。
   * @param signal - 取消信号，透传到仓储。
   * @returns 命中的视图状态；未设置过的执行记录不会出现。
   */
  public async listViewStates(
    userId: string,
    executionIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly ExecutionViewState[]> {
    try {
      return await this.#dependencies.viewStateRepository.listExecutionViewStates(
        userId,
        executionIds,
        signal
      )
    } catch (cause: unknown) {
      throw infrastructureFailure('查询执行结果视图状态失败', cause)
    }
  }

  /**
   * 读取任务并校验归属；查不到抛 NOT_FOUND，查到但非本人抛 FORBIDDEN。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到仓储。
   * @returns 归属校验通过的任务定义。
   */
  public async getOwnedTask(
    userId: string,
    taskId: string,
    signal: AbortSignal
  ): Promise<AgentTaskDefinition> {
    const task = await this.findTask(taskId, signal)
    if (task.userId !== userId) {
      throw new TaskApplicationError(TASK_APPLICATION_ERROR_CODES.FORBIDDEN, '无权访问此任务')
    }
    return task
  }

  /**
   * 分页列出某任务的执行记录；先校验任务归属再查执行历史。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数。
   * @param signal - 取消信号，透传到仓储。
   * @returns 本页执行记录与下一页游标。
   */
  public async listExecutions(
    userId: string,
    taskId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskExecution>> {
    const task = await this.getOwnedTask(userId, taskId, signal)
    try {
      return await this.#dependencies.taskRepository.listExecutions(
        task.taskId,
        cursor,
        limit,
        signal
      )
    } catch (cause: unknown) {
      throw infrastructureFailure('查询执行记录失败', cause)
    }
  }

  /**
   * 读取单条执行记录；任务归属不通过抛 FORBIDDEN，记录不存在抛 EXECUTION_NOT_FOUND。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param executionId - 目标执行记录标识。
   * @param signal - 取消信号，透传到仓储。
   * @returns 目标执行记录。
   */
  public async getExecution(
    userId: string,
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<AgentTaskExecution> {
    await this.getOwnedTask(userId, taskId, signal)
    let execution: AgentTaskExecution | undefined
    try {
      execution = await this.#dependencies.taskRepository.getExecutionById(
        taskId,
        executionId,
        signal
      )
    } catch (cause: unknown) {
      throw infrastructureFailure('查询执行记录失败', cause)
    }
    if (execution === undefined) {
      throw new TaskApplicationError(
        TASK_APPLICATION_ERROR_CODES.EXECUTION_NOT_FOUND,
        '执行记录不存在'
      )
    }
    return execution
  }

  /**
   * 列出某会话下的全部任务；同时按用户过滤，越权会话得到空列表。
   *
   * @param userId - 当前登录用户，用于归属过滤。
   * @param sessionId - 目标会话标识。
   * @param signal - 取消信号，透传到仓储。
   * @returns 该会话的列表项集合。
   */
  public async listBySession(
    userId: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskListItem[]> {
    try {
      return await this.#dependencies.taskListRepository.listItemsBySession(
        sessionId,
        userId,
        signal
      )
    } catch (cause: unknown) {
      throw infrastructureFailure('查询会话任务失败', cause)
    }
  }

  /**
   * 按 ID 读取任务并把「不存在」翻译为 NOT_FOUND 应用错误，其余仓储异常收敛为基础设施失败。
   *
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到仓储。
   * @returns 任务定义；不存在时抛 NOT_FOUND。
   */
  private async findTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition> {
    try {
      return await this.#dependencies.taskRepository.getTask(taskId, signal)
    } catch (cause: unknown) {
      if (
        cause instanceof TaskRepositoryError &&
        cause.code === TASK_REPOSITORY_ERROR_CODES.NOT_FOUND
      ) {
        throw new TaskApplicationError(TASK_APPLICATION_ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      throw infrastructureFailure('查询任务失败', cause)
    }
  }
}
