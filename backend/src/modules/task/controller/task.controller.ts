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

  /**
   * 列出当前用户的任务：游标分页，展示字段由 Presenter 投影。
   * 仓储异常一律收敛成内部错误，不把 SQL 细节透给调用方。
   *
   * @param userId - 当前登录用户，决定可见范围；取自认证上下文而非请求体。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数，调用方需已完成上限收敛。
   * @param signal - 请求取消信号，透传到查询用例。
   * @returns 任务列表 DTO 与下一页游标。
   */
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

  /**
   * 批量取执行结果的视图状态；只返回属于当前用户的执行记录。
   *
   * @param userId - 当前登录用户，用于归属过滤。
   * @param executionIds - 目标执行 ID 列表，调用方需已完成去重与数量上限校验。
   * @param signal - 请求取消信号，透传到查询用例。
   * @returns 命中的视图状态列表；越权或未设置的执行记录不会出现。
   */
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

  /**
   * 读取单个任务详情；不存在与越权都映射成同一条 404，避免探测他人任务。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param signal - 请求取消信号，透传到查询用例。
   * @returns 单任务 DTO。
   */
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

  /**
   * 更新任务的启停状态；属于命令路径，写前先校验所有权。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param input - 已校验的更新 DTO；当前只有 `is_active`。
   * @param signal - 请求取消信号，透传到命令用例。
   * @returns 仅含提示文案的结果信封，更新后不回读任务。
   */
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

  /**
   * 软删除任务：只置停用标记，不物理删除数据。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param signal - 请求取消信号，透传到命令用例。
   * @returns 仅含提示文案的结果信封。
   */
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

  /**
   * 列出某任务的执行记录：先校验任务归属，再游标分页取执行历史。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数，调用方需已完成上限收敛。
   * @param signal - 请求取消信号，透传到查询用例。
   * @returns 执行记录列表 DTO 与下一页游标。
   */
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

  /**
   * 读取单条执行记录详情；任务不存在、执行不存在与越权都收敛到 404。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param executionId - 目标执行记录标识。
   * @param signal - 请求取消信号，透传到查询用例。
   * @returns 单条执行记录 DTO。
   */
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

  /**
   * 更新执行记录的已读/折叠偏好；校验顺序为任务所有权 → 执行存在性 → upsert。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param taskId - 目标任务标识。
   * @param executionId - 目标执行记录标识。
   * @param patch - 已校验的补丁 DTO；`mark_seen` 缺省按 false 处理。
   * @param signal - 请求取消信号，透传到命令用例。
   * @returns 更新后的视图状态 DTO。
   */
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

  /**
   * 列出某个会话下的全部任务；结果同时按用户过滤，越权会话返回空列表。
   *
   * @param userId - 当前登录用户，用于归属过滤。
   * @param sessionId - 目标会话标识。
   * @param signal - 请求取消信号，透传到查询用例。
   * @returns 该会话的任务列表项 DTO。
   */
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
