import type { TransactionalSqlExecutor } from '../../src/infra/database/postgres.js'
import type {
  AgentTaskDefinition,
  AgentTaskExecution,
  AgentTaskListItem,
  ExecutionViewState,
  TaskPage,
} from '../../src/modules/task/model/task.js'
import type { TaskCommandRepository } from '../../src/modules/task/service/persistence/command/port/task-command-repository.port.js'
import type { TaskExecutionRepository } from '../../src/modules/task/service/persistence/execution/port/task-execution-repository.port.js'
import { PostgresTaskCommandRepository } from '../../src/modules/task/service/persistence/command/postgres-task-command-repository.js'
import { PostgresTaskExecutionRepository } from '../../src/modules/task/service/persistence/execution/postgres-task-execution-repository.js'
import { PostgresTaskListReadModel } from '../../src/modules/task/service/persistence/list/postgres-task-list-read-model.js'
import type { TaskListRepository } from '../../src/modules/task/service/persistence/list/port/task-list-repository.port.js'
import { PostgresTaskQueryRepository } from '../../src/modules/task/service/persistence/query/postgres-task-query-repository.js'
import type { TaskQueryRepository } from '../../src/modules/task/service/persistence/query/port/task-query-repository.port.js'
import type { PendingTaskRepository } from '../../src/modules/task/service/scheduling/port/task-scheduler.port.js'
import { PostgresExecutionViewStateRepository } from '../../src/modules/task/service/persistence/view-state/postgres-execution-view-state-repository.js'
import type { ExecutionViewStateRepository } from '../../src/modules/task/service/persistence/view-state/port/execution-view-state-repository.port.js'

/** 测试兼容聚合器：生产组装始终使用各自的窄 Repository Adapter。 */
export class TestPostgresTaskRepositories
  implements
    TaskCommandRepository,
    TaskQueryRepository,
    TaskExecutionRepository,
    TaskListRepository,
    ExecutionViewStateRepository,
    PendingTaskRepository
{
  readonly #commands: PostgresTaskCommandRepository
  readonly #queries: PostgresTaskQueryRepository
  readonly #executions: PostgresTaskExecutionRepository
  readonly #list: PostgresTaskListReadModel
  readonly #viewStates: PostgresExecutionViewStateRepository

  public constructor(database: TransactionalSqlExecutor, now: () => Date = (): Date => new Date()) {
    this.#commands = new PostgresTaskCommandRepository(database, now)
    this.#queries = new PostgresTaskQueryRepository(database)
    this.#executions = new PostgresTaskExecutionRepository(database)
    this.#list = new PostgresTaskListReadModel(database)
    this.#viewStates = new PostgresExecutionViewStateRepository(database, now)
  }

  public claimExecution(taskId: string, token: bigint, signal: AbortSignal): Promise<void> {
    return this.#commands.claimExecution(taskId, token, signal)
  }
  public createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    return this.#commands.createTask(task, signal)
  }
  public updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    return this.#commands.updateTaskContent(task, signal)
  }
  public updateTask(task: AgentTaskDefinition, signal: AbortSignal, token?: bigint): Promise<void> {
    return this.#commands.updateTask(task, signal, token)
  }
  public saveExecutionWithTaskUpdate(
    task: AgentTaskDefinition,
    execution: AgentTaskExecution,
    signal: AbortSignal,
    token?: bigint
  ): Promise<void> {
    return this.#commands.saveExecutionWithTaskUpdate(task, execution, signal, token)
  }
  public softDeleteTask(userId: string, taskId: string, signal: AbortSignal): Promise<void> {
    return this.#commands.softDeleteTask(userId, taskId, signal)
  }
  public getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition> {
    return this.#queries.getTask(taskId, signal)
  }
  public getPendingTasks(
    now: Date,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    return this.#queries.getPendingTasks(now, limit, signal)
  }
  public listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskDefinition>> {
    return this.#queries.listByUser(userId, cursor, limit, signal)
  }
  public listBySession(
    userId: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    return this.#queries.listBySession(userId, sessionId, signal)
  }
  public listExecutions(
    taskId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskExecution>> {
    return this.#queries.listExecutions(taskId, cursor, limit, signal)
  }
  public getExecutionById(
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<AgentTaskExecution | undefined> {
    return this.#queries.getExecutionById(taskId, executionId, signal)
  }
  public markExecutionDelivered(executionId: string, signal: AbortSignal): Promise<boolean> {
    return this.#executions.markExecutionDelivered(executionId, signal)
  }
  public listUndeliveredExecutions(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskExecution[]> {
    return this.#executions.listUndeliveredExecutions(sessionId, signal)
  }
  public listItemsByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskListItem>> {
    return this.#list.listItemsByUser(userId, cursor, limit, signal)
  }
  public listItemsBySession(
    userId: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskListItem[]> {
    return this.#list.listItemsBySession(userId, sessionId, signal)
  }
  public listExecutionViewStates(
    userId: string,
    executionIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly ExecutionViewState[]> {
    return this.#viewStates.listExecutionViewStates(userId, executionIds, signal)
  }
  public upsertExecutionViewState(
    userId: string,
    executionId: string,
    markSeen: boolean,
    collapsedOverride: boolean | undefined,
    signal: AbortSignal
  ): Promise<ExecutionViewState> {
    return this.#viewStates.upsertExecutionViewState(
      userId,
      executionId,
      markSeen,
      collapsedOverride,
      signal
    )
  }
}
