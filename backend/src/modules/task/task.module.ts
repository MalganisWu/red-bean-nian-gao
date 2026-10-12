import type { AppConfig } from './../../infra/config/config.js'
import { parseDurationMilliseconds } from './../../infra/config/config.js'
import type { TransactionalSqlExecutor } from './../../infra/database/postgres.js'
import type { Logger } from './../../infra/logger/logger.js'
import type { RedisConnection } from './../../infra/redis/redis.js'
import { newTraceId } from './../../infra/observability/structured-log-tracer.js'
import { abortableDelay } from './../../shared/async/abortable-delay.js'
import { normalizeError } from './../../shared/errors/normalize-error.js'
import type { IdGenerator } from './../../shared/id/id-generator.js'
import type { BackgroundTask } from './../../shared/lifecycle/background-task.js'
import type { Tracer } from './../../platform/observability/public-api.js'
import type {
  AgentTaskCapabilities,
  AgentTool,
  TaskResultDeliveryPort,
} from './../agent/public-api.js'
import { DeliveryQueue } from './service/delivery/default-task-delivery-service.js'
import type {
  SchedulerConfig,
  TaskSchedulerPort,
} from './service/scheduling/port/task-scheduler.port.js'
import { RedisDeliveryQueueStore } from './service/delivery/redis-task-delivery-queue.js'
import {
  TaskExecutionService,
  type ScheduledTaskPolicy,
} from './service/scheduling/task-execution-service.js'
import { ScheduledTaskScheduler } from './service/scheduling/default-task-scheduler.js'
import type {
  PendingTaskRepository,
  ScheduledTaskLockRegistry,
} from './service/scheduling/port/task-scheduler.port.js'
import { PostgresTaskCommandRepository } from './service/persistence/command/postgres-task-command-repository.js'
import type { TaskCommandRepository } from './service/persistence/command/port/task-command-repository.port.js'
import { PostgresTaskExecutionRepository } from './service/persistence/execution/postgres-task-execution-repository.js'
import type { TaskExecutionRepository } from './service/persistence/execution/port/task-execution-repository.port.js'
import { PostgresTaskListReadModel } from './service/persistence/list/postgres-task-list-read-model.js'
import type { TaskListRepository } from './service/persistence/list/port/task-list-repository.port.js'
import { PostgresTaskQueryRepository } from './service/persistence/query/postgres-task-query-repository.js'
import type { TaskQueryRepository } from './service/persistence/query/port/task-query-repository.port.js'
import { PostgresExecutionViewStateRepository } from './service/persistence/view-state/postgres-execution-view-state-repository.js'
import type { ExecutionViewStateRepository } from './service/persistence/view-state/port/execution-view-state-repository.port.js'
import { TaskCommandService } from './service/cases/task-command-service.js'
import { TaskQueryService } from './service/cases/task-query-service.js'
import { ScheduledTaskManageTool } from './service/tool/scheduled-task-tool.js'
import { ScheduledTaskWorker } from './service/scheduling/scheduled-task-worker.js'

const DELIVERY_RECONCILE_INTERVAL_MILLISECONDS = 30_000

export interface TaskPersistence {
  createManagementTool(idGenerator: IdGenerator, timezone: string): AgentTool
  createModule(options: TaskModuleAssemblyOptions): TaskModule
}

export interface TaskModule {
  readonly deliveryQueue: TaskResultDeliveryPort
  readonly scheduler: TaskSchedulerPort
  readonly commandService: TaskCommandService
  readonly queryService: TaskQueryService
  readonly backgroundTasks: readonly BackgroundTask[]
}

interface TaskRepositories {
  readonly commands: TaskCommandRepository
  readonly queries: TaskQueryRepository
  readonly pending: PendingTaskRepository
  readonly executions: TaskExecutionRepository
  readonly listReadModel: TaskListRepository
  readonly viewStates: ExecutionViewStateRepository
}

interface TaskModuleAssemblyOptions {
  readonly redis: RedisConnection
  readonly agent: AgentTaskCapabilities & {
    readonly sessionLocks: ScheduledTaskLockRegistry
  }
  readonly idGenerator: IdGenerator
  readonly tracer: Tracer
  readonly logger: Logger
  readonly config: AppConfig
}

/** 封装 Task Module 私有仓储，只向 composition root 提供工具与模块组装能力。 */
class DefaultTaskPersistence implements TaskPersistence {
  readonly #repositories: TaskRepositories

  public constructor(repositories: TaskRepositories) {
    this.#repositories = repositories
  }

  public createManagementTool(idGenerator: IdGenerator, timezone: string): AgentTool {
    return new ScheduledTaskManageTool(
      { commands: this.#repositories.commands, queries: this.#repositories.queries },
      idGenerator,
      timezone
    )
  }

  public createModule(options: TaskModuleAssemblyOptions): TaskModule {
    return assembleTaskModule(this.#repositories, options)
  }
}

/** 提前建立 Task 私有持久化能力，供工具与完整 Module 在同一所有者内组装。 */
export function createTaskPersistence(database: TransactionalSqlExecutor): TaskPersistence {
  const queries = new PostgresTaskQueryRepository(database)
  return new DefaultTaskPersistence({
    commands: new PostgresTaskCommandRepository(database),
    queries,
    pending: queries,
    executions: new PostgresTaskExecutionRepository(database),
    listReadModel: new PostgresTaskListReadModel(database),
    viewStates: new PostgresExecutionViewStateRepository(database),
  })
}

/** 组装 Task Module 的投递、执行、调度和 HTTP 入站 Port。 */
export function createTaskModule(options: {
  readonly persistence: TaskPersistence
  readonly redis: RedisConnection
  readonly agent: AgentTaskCapabilities & {
    readonly sessionLocks: ScheduledTaskLockRegistry
  }
  readonly idGenerator: IdGenerator
  readonly tracer: Tracer
  readonly logger: Logger
  readonly config: AppConfig
}): TaskModule {
  const { persistence, ...assemblyOptions } = options
  return persistence.createModule(assemblyOptions)
}

/**
 * Task Module 组装目录——自上而下一条流水线：
 *   持久化 → 投递 → 执行 → 调度 → 查询/命令用例 → 后台任务
 * 各能力段的装配见文件下方同名私有工厂，函数名即段落标题，每段正文不超过一屏。
 */
function assembleTaskModule(
  persistence: TaskRepositories,
  options: TaskModuleAssemblyOptions
): TaskModule {
  const {
    commands: commandRepository,
    queries: queryRepository,
    executions,
    pending,
    listReadModel,
    viewStates,
  } = persistence
  const deliveryQueue = createDelivery(queryRepository, executions, options)
  const execution = createExecution(commandRepository, queryRepository, deliveryQueue, options)
  const scheduler = createScheduler(pending, execution, options)
  const worker = createWorker(scheduler, options)
  const cases = createCases(commandRepository, queryRepository, listReadModel, viewStates)
  return {
    deliveryQueue,
    scheduler,
    queryService: cases.queryService,
    commandService: cases.commandService,
    backgroundTasks: [
      (signal): Promise<void> => worker.start(signal),
      reconcileTask(deliveryQueue, options.logger, DELIVERY_RECONCILE_INTERVAL_MILLISECONDS),
    ],
  }
}

/** 投递段：执行结果入 Redis 队列并周期 reconcile，交由 Agent 展示链路消费。 */
function createDelivery(
  queryRepository: TaskQueryRepository,
  executions: TaskExecutionRepository,
  options: TaskModuleAssemblyOptions
): DeliveryQueue {
  return new DeliveryQueue(
    new RedisDeliveryQueueStore(options.redis),
    queryRepository,
    executions,
    options.agent.externalTurnWriter,
    options.agent.sessionLocks
  )
}

/**
 * 执行段：TaskExecutionService 聚合一次任务运行的完整流程
 * （认领 → 调 Agent → 保存结果 → 成功投递/失败重试），组装点见此处。
 */
function createExecution(
  commandRepository: TaskCommandRepository,
  queryRepository: TaskQueryRepository,
  queue: DeliveryQueue,
  options: TaskModuleAssemblyOptions
): TaskExecutionService {
  return new TaskExecutionService({
    queries: queryRepository,
    commands: commandRepository,
    idGenerator: options.idGenerator,
    background: options.agent.backgroundExecution,
    queue,
    policy: scheduledTaskPolicy(options.config),
    tracer: options.tracer,
    traceIdFactory: newTraceId,
  })
}

/** 调度段：扫描到期任务并调用执行服务；Scheduler 与 Worker 分离驱动与节流。 */
function createScheduler(
  pending: PendingTaskRepository,
  execution: TaskExecutionService,
  options: TaskModuleAssemblyOptions
): ScheduledTaskScheduler {
  return new ScheduledTaskScheduler(
    pending,
    (taskId, lease, signal): Promise<void> => execution.run(taskId, lease, signal),
    options.agent.sessionLocks,
    schedulerConfig(options.config),
    options.logger
  )
}

function createWorker(
  scheduler: ScheduledTaskScheduler,
  options: TaskModuleAssemblyOptions
): ScheduledTaskWorker {
  return new ScheduledTaskWorker(
    scheduler,
    options.logger,
    parseDurationMilliseconds(options.config.scheduledTask.scanInterval)
  )
}

/** 用例段：查询与命令用例，HTTP 控制器与系统的直接入口。 */
function createCases(
  commandRepository: TaskCommandRepository,
  queryRepository: TaskQueryRepository,
  listReadModel: TaskListRepository,
  viewStates: ExecutionViewStateRepository
): { readonly queryService: TaskQueryService; readonly commandService: TaskCommandService } {
  return {
    queryService: new TaskQueryService({
      taskRepository: queryRepository,
      taskListRepository: listReadModel,
      viewStateRepository: viewStates,
    }),
    commandService: new TaskCommandService({
      commandRepository,
      queryRepository,
      viewStateRepository: viewStates,
    }),
  }
}

function schedulerConfig(config: AppConfig): SchedulerConfig {
  return {
    batchSize: config.scheduledTask.batchSize,
    maxConcurrent: config.scheduledTask.maxConcurrent,
    executionTimeoutMilliseconds: parseDurationMilliseconds(config.scheduledTask.executionTimeout),
  }
}

function scheduledTaskPolicy(config: AppConfig): ScheduledTaskPolicy {
  return {
    maxRetries: config.scheduledTask.maxRetries,
    retryIntervalMilliseconds: parseDurationMilliseconds(config.scheduledTask.retryInterval),
    timezone: config.scheduledTask.timezone,
  }
}

function reconcileTask(
  queue: Pick<DeliveryQueue, 'reconcileAll'>,
  logger: Logger,
  intervalMilliseconds: number
): BackgroundTask {
  return async (signal): Promise<void> => {
    await reconcileOnce(queue, logger, signal)
    while (!signal.aborted) {
      try {
        await abortableDelay(intervalMilliseconds, signal)
      } catch {
        return
      }
      if (!signal.aborted) await reconcileOnce(queue, logger, signal)
    }
  }
}

async function reconcileOnce(
  queue: Pick<DeliveryQueue, 'reconcileAll'>,
  logger: Logger,
  signal: AbortSignal
): Promise<void> {
  try {
    await queue.reconcileAll(signal)
    logger.info('delivery queue reconcile completed')
  } catch (cause: unknown) {
    if (!signal.aborted)
      logger.warn('delivery queue reconcile failed', { error: normalizeError(cause) })
  }
}
