import {
  TASK_REPOSITORY_ERROR_CODES,
  TaskRepositoryError,
  type AgentTaskDefinition,
  type ExecutionViewState,
} from './../../model/task.js'
import type { TaskCommandRepository } from './../persistence/command/port/task-command-repository.port.js'
import type { TaskQueryRepository } from './../persistence/query/port/task-query-repository.port.js'
import type { ExecutionViewStateRepository } from './../persistence/view-state/port/execution-view-state-repository.port.js'
import {
  TASK_APPLICATION_ERROR_CODES,
  TaskApplicationError,
  infrastructureFailure,
} from './../error/task-application-error.js'

/** 命令用例依赖；`queryRepository` 只收窄到所有权校验真正用到的两个方法。 */
export interface TaskCommandServiceDependencies {
  readonly commandRepository: TaskCommandRepository
  readonly queryRepository: Pick<TaskQueryRepository, 'getTask' | 'getExecutionById'>
  readonly viewStateRepository: ExecutionViewStateRepository
}

/**
 * Task 命令用例默认实现：在持久化前统一执行所有权和目标存在性校验。
 * 失败语义：任务不存在/无权 → `TaskApplicationError`（NOT_FOUND / FORBIDDEN）；
 * 仓储层异常一律翻译为基础设施失败（infrastructureFailure），不向外泄漏 SQL 细节。
 */
export class TaskCommandService {
  readonly #dependencies: TaskCommandServiceDependencies

  public constructor(dependencies: TaskCommandServiceDependencies) {
    this.#dependencies = dependencies
  }

  /** 启停任务（软启停，不删数据）：先校验所有权，再落库。 */
  public async setActive(
    userId: string,
    taskId: string,
    isActive: boolean,
    signal: AbortSignal
  ): Promise<void> {
    // 所有权必须在此前置校验：commandRepository.updateTask 的 WHERE 只按 taskId 过滤
    // （fencing 路径复用同一条更新），不重新校验 userId。
    const task = await this.ownedTask(userId, taskId, signal)
    task.isActive = isActive
    try {
      await this.#dependencies.commandRepository.updateTask(task, signal)
    } catch (cause: unknown) {
      throw infrastructureFailure('更新任务失败', cause)
    }
  }

  /** 软删除任务：所有权由仓储的 `WHERE user_id` 保证，NOT_FOUND/NOT_AUTHORIZED 统一翻译。 */
  public async delete(userId: string, taskId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#dependencies.commandRepository.softDeleteTask(userId, taskId, signal)
    } catch (cause: unknown) {
      throw mapRepositoryFailure(cause, '删除任务失败')
    }
  }

  /**
   * 更新执行记录的已读/折叠视图状态。
   * 校验顺序固定为：任务所有权 → 执行记录存在性 → upsert；
   * 三个失败面分别映射 FORBIDDEN / EXECUTION_NOT_FOUND / 基础设施失败。
   */
  public async updateViewState(
    userId: string,
    taskId: string,
    executionId: string,
    patch: { readonly markSeen: boolean; readonly collapsedOverride?: boolean | undefined },
    signal: AbortSignal
  ): Promise<ExecutionViewState> {
    await this.ownedTask(userId, taskId, signal)
    let execution
    try {
      execution = await this.#dependencies.queryRepository.getExecutionById(
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
    try {
      return await this.#dependencies.viewStateRepository.upsertExecutionViewState(
        userId,
        executionId,
        patch.markSeen,
        patch.collapsedOverride,
        signal
      )
    } catch (cause: unknown) {
      throw infrastructureFailure('更新执行结果视图状态失败', cause)
    }
  }

  /** 读取任务并校验归属：查不到 → NOT_FOUND；查到但非本人 → FORBIDDEN。 */
  private async ownedTask(
    userId: string,
    taskId: string,
    signal: AbortSignal
  ): Promise<AgentTaskDefinition> {
    let task: AgentTaskDefinition
    try {
      task = await this.#dependencies.queryRepository.getTask(taskId, signal)
    } catch (cause: unknown) {
      throw mapRepositoryFailure(cause, '查询任务失败')
    }
    if (task.userId !== userId) {
      throw new TaskApplicationError(TASK_APPLICATION_ERROR_CODES.FORBIDDEN, '无权访问此任务')
    }
    return task
  }
}

function mapRepositoryFailure(cause: unknown, message: string): TaskApplicationError {
  if (cause instanceof TaskRepositoryError) {
    if (cause.code === TASK_REPOSITORY_ERROR_CODES.NOT_FOUND) {
      return new TaskApplicationError(TASK_APPLICATION_ERROR_CODES.NOT_FOUND, '任务不存在')
    }
    if (cause.code === TASK_REPOSITORY_ERROR_CODES.NOT_AUTHORIZED) {
      return new TaskApplicationError(TASK_APPLICATION_ERROR_CODES.FORBIDDEN, '无权访问此任务')
    }
  }
  return infrastructureFailure(message, cause)
}
