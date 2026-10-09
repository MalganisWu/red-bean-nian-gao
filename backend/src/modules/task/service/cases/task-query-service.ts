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

export interface TaskQueryServiceDependencies {
  readonly taskRepository: TaskQueryRepository
  readonly taskListRepository: TaskListRepository
  readonly viewStateRepository: ExecutionViewStateRepository
}

/** Task 查询用例默认实现：集中处理资源所有权与 Repository 失败语义。 */
export class TaskQueryService {
  readonly #dependencies: TaskQueryServiceDependencies

  public constructor(dependencies: TaskQueryServiceDependencies) {
    this.#dependencies = dependencies
  }

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
