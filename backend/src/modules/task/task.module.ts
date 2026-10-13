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

/** 投递队列周期对账的间隔（毫秒）；兜住「落库成功但入队丢失」的补偿窗口。 */
const DELIVERY_RECONCILE_INTERVAL_MILLISECONDS = 30_000

/**
 * Task Module 的组装入口。生产实现的 Port → 实现映射全部集中在本文件，
 * composition root 只负责把基础设施与跨 Module 能力传进来。
 *
 * 分成 `createTaskPersistence`（只依赖数据库，先建）与 `createModule`（还需要 Redis、
 * Agent 能力与配置）两步，是为了解开一个循环：Agent Module 要用 Task 的投递队列，
 * 而 Task 又要用 Agent 的执行能力。先建不依赖 Agent 的持久化层，才能在后面各取所需。
 */
export interface TaskPersistence {
  /**
   * 用已建好的私有仓储构造定时任务管理工具，交给平台工具注册。
   *
   * @param idGenerator - 新任务 ID 生成器。
   * @param timezone - 解释 run_at 与 cron 所用时区。
   * @returns 注册进 Tool Registry 的 AgentTool。
   */
  createManagementTool(idGenerator: IdGenerator, timezone: string): AgentTool

  /**
   * 用已建好的私有仓储组装完整 Task Module。
   *
   * @param options - 组装选项：Redis、Agent 能力、ID 生成、追踪、日志与配置。
   * @returns Task Module 的输出面。
   */
  createModule(options: TaskModuleAssemblyOptions): TaskModule
}

/** Task Module 的输出面：投递队列、调度器、两个用例服务与需随进程收束的后台任务。 */
export interface TaskModule {
  /** 执行结果投递队列；实现 Agent 的 TaskResultDeliveryPort，跨模块交付结果。 */
  readonly deliveryQueue: TaskResultDeliveryPort
  /** 调度器；对外只暴露扫描、执行与停机等待三个动作。 */
  readonly scheduler: TaskSchedulerPort
  /** 命令用例服务；HTTP 与系统写路径的入口。 */
  readonly commandService: TaskCommandService
  /** 查询用例服务；HTTP 与系统读路径的入口。 */
  readonly queryService: TaskQueryService
  /** 需随进程收束的后台任务（如调度 worker 与投递对账循环）。 */
  readonly backgroundTasks: readonly BackgroundTask[]
}

/** Task Module 私有仓储集合；由 createTaskPersistence 一次建齐并封装，不外泄。 */
interface TaskRepositories {
  /** 写路径仓储：认领、创建、更新与软删除。 */
  readonly commands: TaskCommandRepository
  /** 任务与执行历史读取仓储。 */
  readonly queries: TaskQueryRepository
  /** 调度扫描仓储；取到期任务。 */
  readonly pending: PendingTaskRepository
  /** 执行记录与投递确认仓储。 */
  readonly executions: TaskExecutionRepository
  /** 任务列表读模型；Task 与 Session 标题 JOIN 的唯一位置。 */
  readonly listReadModel: TaskListRepository
  /** 已读/折叠偏好仓储。 */
  readonly viewStates: ExecutionViewStateRepository
}

/** 组装完整 Module 所需的跨层依赖；与私有仓储分离，供 createModule 传入。 */
interface TaskModuleAssemblyOptions {
  /** Redis 连接；投递队列存储依赖它。 */
  readonly redis: RedisConnection
  /** Agent 跨模块能力：后台执行、外部会话写入与会话锁注册表。 */
  readonly agent: AgentTaskCapabilities & {
    readonly sessionLocks: ScheduledTaskLockRegistry
  }
  /** ID 生成器；工具与执行服务共用。 */
  readonly idGenerator: IdGenerator
  /** 链路追踪器。 */
  readonly tracer: Tracer
  /** 日志出口。 */
  readonly logger: Logger
  /** 应用配置；调度参数从 scheduledTask 段读取。 */
  readonly config: AppConfig
}

/** 封装 Task Module 私有仓储，只向 composition root 提供工具与模块组装能力。 */
class DefaultTaskPersistence implements TaskPersistence {
  /** 封装好的私有仓储；只有本类能读到，composition root 拿不到。 */
  readonly #repositories: TaskRepositories

  public constructor(repositories: TaskRepositories) {
    this.#repositories = repositories
  }

  /**
   * 用私有仓储构造定时任务管理工具；只把工具真正用到的两个仓储视图传出去。
   *
   * @param idGenerator - 新任务 ID 生成器。
   * @param timezone - 解释 run_at 与 cron 所用时区。
   * @returns 注册进 Tool Registry 的 AgentTool。
   */
  public createManagementTool(idGenerator: IdGenerator, timezone: string): AgentTool {
    return new ScheduledTaskManageTool(
      { commands: this.#repositories.commands, queries: this.#repositories.queries },
      idGenerator,
      timezone
    )
  }

  /**
   * 组装完整 Task Module。
   *
   * @param options - 组装选项。
   * @returns Task Module 的输出面。
   */
  public createModule(options: TaskModuleAssemblyOptions): TaskModule {
    return assembleTaskModule(this.#repositories, options)
  }
}

/**
 * 提前建立 Task 私有持久化能力，供工具与完整 Module 在同一所有者内组装。
 *
 * @param database - 事务型 SQL 执行器，六个仓储共用同一连接入口。
 * @returns 只暴露工具与模块组装能力的 TaskPersistence，不泄漏内部仓储。
 */
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

/**
 * 组装 Task Module 的投递、执行、调度和 HTTP 入站 Port。
 *
 * @param options - 组装选项；`persistence` 之外的字段原样转交给内部组装。
 * @returns Task Module 的输出面，含投递队列、调度器、用例服务与后台任务。
 */
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
 *
 * @param persistence - 已建齐的私有仓储集合。
 * @param options - 组装选项：Redis、Agent 能力、ID 生成、追踪、日志与配置。
 * @returns Task Module 的输出面，含投递队列、调度器、用例服务与后台任务。
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

/**
 * 投递段：执行结果入 Redis 队列并周期 reconcile，交由 Agent 展示链路消费。
 *
 * @param queryRepository - 任务读取仓储，投递前据此取任务与执行记录。
 * @param executions - 执行记录仓储，提供投递确认与未投递扫描。
 * @param options - 组装选项；取 Redis 连接、会话写入 Port 与锁注册表。
 * @returns 实现 TaskResultDeliveryPort 的投递队列。
 */
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
 *
 * @param commandRepository - 写路径仓储；认领、更新任务与执行落库。
 * @param queryRepository - 任务读取仓储。
 * @param queue - 投递队列，用于把执行结果推进会话。
 * @param options - 组装选项；取 ID 生成、Agent 后台执行、追踪与配置。
 * @returns 执行服务实例。
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

/**
 * 调度段：扫描到期任务并调用执行服务；Scheduler 与 Worker 分离驱动与节流。
 *
 * @param pending - 到期任务扫描仓储。
 * @param execution - 执行服务，作为调度 pipeline。
 * @param options - 组装选项；取 Agent 会话锁、日志与调度配置。
 * @returns 默认调度器实现。
 */
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

/**
 * 进程级驱动：把调度器包成按固定间隔触发扫描的 Worker，扫描间隔取自配置。
 *
 * @param scheduler - 目标调度器。
 * @param options - 组装选项；取日志与 scanInterval 配置。
 * @returns 定时触发扫描的 Worker。
 */
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

/**
 * 用例段：查询与命令用例，HTTP 控制器与系统的直接入口。
 *
 * @param commandRepository - 写路径仓储。
 * @param queryRepository - 任务与执行读取仓储。
 * @param listReadModel - 任务列表读模型。
 * @param viewStates - 已读/折叠偏好仓储。
 * @returns 查询与命令两个用例服务。
 */
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

/**
 * 从应用配置投影出调度配置：批量、并发与执行超时统一走配置，并有 duration 解析兜底。
 *
 * @param config - 应用配置。
 * @returns 调度器可用的扫描配置。
 */
function schedulerConfig(config: AppConfig): SchedulerConfig {
  return {
    batchSize: config.scheduledTask.batchSize,
    maxConcurrent: config.scheduledTask.maxConcurrent,
    executionTimeoutMilliseconds: parseDurationMilliseconds(config.scheduledTask.executionTimeout),
  }
}

/**
 * 从应用配置投影出重试策略：最大重试次数、重试间隔与时区。
 *
 * @param config - 应用配置。
 * @returns 执行服务使用的重试与 cron 策略。
 */
function scheduledTaskPolicy(config: AppConfig): ScheduledTaskPolicy {
  return {
    maxRetries: config.scheduledTask.maxRetries,
    retryIntervalMilliseconds: parseDurationMilliseconds(config.scheduledTask.retryInterval),
    timezone: config.scheduledTask.timezone,
  }
}

/**
 * 把投递队列的周期对账包装成后台任务：先对账一次，之后按间隔循环直到收到中止信号。
 *
 * @param queue - 投递队列；只需 reconcileAll 一个方法。
 * @param logger - 日志出口，记录对账成败。
 * @param intervalMilliseconds - 两次对账的间隔（毫秒）。
 * @returns 接受中止信号的后台任务函数。
 */
function reconcileTask(
  queue: Pick<DeliveryQueue, 'reconcileAll'>,
  logger: Logger,
  intervalMilliseconds: number
): BackgroundTask {
  /** 周期性对账投递队列，直到收到中止信号。 */
  async function reconcileLoop(signal: AbortSignal): Promise<void> {
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
  return reconcileLoop
}

/**
 * 执行一次全量投递对账；失败只在未中止时记警告，不上抛——对账由下一轮循环自然重试。
 *
 * @param queue - 投递队列；只需 reconcileAll 一个方法。
 * @param logger - 日志出口。
 * @param signal - 取消信号；已中止时不再记录失败告警。
 */
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
