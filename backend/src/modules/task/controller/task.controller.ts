import type {
  ExecutionViewStateDto,
  ExecutionViewStatePatchDto,
  TaskDto,
  TaskExecutionDto,
  TaskExecutionListDto,
  TaskListDto,
  TaskListItemDto,
  UpdateTaskDto,
} from './task.dto.js'

import type { TaskCommandService } from './../service/cases/task-command-service.js'
import type { TaskQueryService } from './../service/cases/task-query-service.js'
import {
  TASK_APPLICATION_ERROR_CODES,
  TaskApplicationError,
} from './../service/error/task-application-error.js'
import {
  forbiddenError,
  loggedInternalError,
  notFoundError,
} from './../../../shared/http/error-mapper.js'
import {
  toExecutionDto,
  toExecutionViewStateDto,
  toTaskDto,
  toTaskListItemDto,
} from './task-presenter.js'

/**
 * Task 查询与命令用例入口依赖。
 * 内部 1:1 实现类（无独立 Port），由 `task.module.ts` 组装；展示字段由 Task 内部 Presenter 进行纯映射。
 */
export interface TaskControllerDependencies {
  readonly queries: TaskQueryService
  readonly commands: TaskCommandService
}

/**
 * Task 的 HTTP 用例控制器：方法签名即"入参 + 返回"，不接触 Fastify 类型；负责 DTO 投影与应用错误映射。
 * 请求解包、Principal 传递与成功信封输出由 `task.routes.ts` 承担。
 */
export class TaskController {
  readonly #dependencies: TaskControllerDependencies

  public constructor(dependencies: TaskControllerDependencies) {
    this.#dependencies = dependencies
  }

  public async list(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskListDto> {
    try {
      const page = await this.#dependencies.queries.listByUser(userId, cursor, limit, signal)
      return { tasks: page.items.map(toTaskListItemDto), next_cursor: page.nextCursor }
    } catch (cause: unknown) {
      throw loggedInternalError('查询任务列表失败', cause)
    }
  }

  public async listViewStates(
    userId: string,
    executionIds: readonly string[],
    signal: AbortSignal
  ): Promise<{ readonly view_states: ExecutionViewStateDto[] }> {
    try {
      const states = await this.#dependencies.queries.listViewStates(userId, executionIds, signal)
      return { view_states: states.map(toExecutionViewStateDto) }
    } catch (cause: unknown) {
      throw loggedInternalError('查询执行结果视图状态失败', cause)
    }
  }

  public async detail(
    userId: string,
    taskId: string,
    signal: AbortSignal
  ): Promise<{ readonly task: TaskDto }> {
    const task = await this.#mapFailure(() =>
      this.#dependencies.queries.getOwnedTask(userId, taskId, signal)
    )
    return { task: toTaskDto(task) }
  }

  public async update(
    userId: string,
    taskId: string,
    input: UpdateTaskDto,
    signal: AbortSignal
  ): Promise<{ readonly message: string }> {
    await this.#mapFailure(() =>
      this.#dependencies.commands.setActive(userId, taskId, input.is_active, signal)
    )
    return { message: '任务更新成功' }
  }

  public async delete(
    userId: string,
    taskId: string,
    signal: AbortSignal
  ): Promise<{ readonly message: string }> {
    try {
      await this.#dependencies.commands.delete(userId, taskId, signal)
    } catch (cause: unknown) {
      throw mapTaskFailure(cause, '删除任务失败')
    }
    return { message: '任务已删除' }
  }

  public async listExecutions(
    userId: string,
    taskId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskExecutionListDto> {
    try {
      const page = await this.#dependencies.queries.listExecutions(
        userId,
        taskId,
        cursor,
        limit,
        signal
      )
      return { executions: page.items.map(toExecutionDto), next_cursor: page.nextCursor }
    } catch (cause: unknown) {
      throw loggedInternalError('查询执行记录失败', cause)
    }
  }

  public async executionDetail(
    userId: string,
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<{ readonly execution: TaskExecutionDto }> {
    const execution = await this.#mapFailure(() =>
      this.#dependencies.queries.getExecution(userId, taskId, executionId, signal)
    )
    return { execution: toExecutionDto(execution) }
  }

  public async updateViewState(
    userId: string,
    taskId: string,
    executionId: string,
    patch: ExecutionViewStatePatchDto,
    signal: AbortSignal
  ): Promise<{ readonly view_state: ExecutionViewStateDto }> {
    const state = await this.#mapFailure(() =>
      this.#dependencies.commands.updateViewState(
        userId,
        taskId,
        executionId,
        {
          markSeen: patch.mark_seen === true,
          collapsedOverride: patch.collapsed_override,
        },
        signal
      )
    )
    return { view_state: toExecutionViewStateDto(state) }
  }

  public async listBySession(
    userId: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<{ readonly tasks: TaskListItemDto[] }> {
    try {
      const tasks = await this.#dependencies.queries.listBySession(userId, sessionId, signal)
      return { tasks: tasks.map(toTaskListItemDto) }
    } catch (cause: unknown) {
      throw loggedInternalError('查询会话任务失败', cause)
    }
  }

  async #mapFailure<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    try {
      return await operation()
    } catch (cause: unknown) {
      throw mapTaskFailure(cause)
    }
  }
}

function mapTaskFailure(cause: unknown, logMessage = '任务用例执行失败'): Error {
  if (cause instanceof TaskApplicationError) {
    if (cause.code === TASK_APPLICATION_ERROR_CODES.NOT_FOUND) return notFoundError('任务不存在')
    if (cause.code === TASK_APPLICATION_ERROR_CODES.EXECUTION_NOT_FOUND)
      return notFoundError('执行记录不存在')
    if (cause.code === TASK_APPLICATION_ERROR_CODES.FORBIDDEN)
      return forbiddenError('无权访问此任务')
  }
  return loggedInternalError(logMessage, cause)
}
