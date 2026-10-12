import type { SqlExecutor } from '../../infra/database/postgres.js'
import type { RedisConnection } from '../../infra/redis/redis.js'
import type { Logger } from '../../infra/logger/logger.js'
import type { IdGenerator } from '../../shared/id/id-generator.js'
import type { TracerPort } from '../../shared/observability/tracer.js'
import type { TaskResultDeliveryPort } from './task-result-delivery/port/task-result-delivery.port.js'
import type { CancelRegistryPort } from './cancellation/port/cancellation-registry.port.js'
import type { AgentRunServicePort } from './run/port/agent-run-service.port.js'
import type { SessionLockRegistry } from './session/lock/port/session-lock.js'
import type { LlmProviderRegistry } from '../../platform/llm/registry/llm-registry.js'
import type { ToolRegistry } from '../../platform/tool/registry/tool-registry.js'
import { DbMainAgentLoader } from './loader/adapter/database-agent-loader.js'
import { PreparedAgentLoader } from './loader/service/prepared-agent-loader.js'
import { wrapAgentLoader } from './observability/agent-observability.js'
import { RuntimeAgentExecutor } from './execution/adapter/runtime-agent-executor.js'
import { RuntimeStateCodec } from './execution/adapter/runtime-state-codec.js'
import { SubExecutionRecovery } from './subagent/recovery/service/default-sub-execution-recovery.js'
import { PostgresSubExecutionRepository } from './subagent/repository/adapter/postgres-sub-execution-repository.js'
import { RuntimeSubAgentToolFactory } from './subagent/tool-factory/adapter/runtime-subagent-tool-factory.js'
import { PostgresSessionRepository } from './session/repository/adapter/postgres-session-repository.js'
import { PostgresRunFactRepository } from './run-facts/adapter/postgres-run-fact-repository.js'
import { RedisMessageBuffer } from './session/message-buffer/adapter/redis-message-buffer.js'
import { RedisCancelRegistry } from './cancellation/adapter/redis-cancellation-registry.js'
import { RedisSessionLockRegistry } from './session/lock/adapter/redis-session-lock.js'
import { SessionLifecycle } from './session/run/service/default-session-run-service.js'
import { DefaultSessionQueryService } from './session/query/service/default-session-query-service.js'
import { ProductAgentRunService } from './run/service/default-agent-run-service.js'
import { DefaultBackgroundAgentExecutionService } from './background-execution/service/default-background-agent-execution-service.js'
import { DefaultExternalSessionTurnWriter } from './external-turn/service/default-external-session-turn-writer.js'
import type { BackgroundAgentExecutionPort } from './background-execution/port/background-agent-execution.port.js'
import type { ExternalSessionTurnWriterPort } from './external-turn/port/external-session-turn-writer.port.js'
import { DefaultChatService } from './chat/service/default-chat-service.js'
import type { ChatRunLifecyclePort, ChatUseCasePort } from './chat/port/chat-use-case.port.js'
import { DefaultTrajectoryService } from './trajectory/service/default-trajectory-service.js'

/** Task 等后台业务可依赖的 Agent 公共能力，不暴露 Runtime 与 Session Adapter。 */
export interface AgentTaskCapabilities {
  readonly backgroundExecution: BackgroundAgentExecutionPort
  readonly externalTurnWriter: ExternalSessionTurnWriterPort
}

/**
 * Agent/Task 两阶段组装使用的窄公开句柄。
 *
 * Task 只能读取执行、外部回合、展示序列化与 Session 锁能力；第二阶段需要的 Repository、Buffer、
 * Executor 和 Loader 被闭包持有，不进入 public-api 生成的声明文件。
 */
export interface AgentModuleCore extends AgentTaskCapabilities {
  readonly sessionLocks: SessionLockRegistry
  complete(deliveryQueue: TaskResultDeliveryPort, idGenerator: IdGenerator): AgentModule
}

/** 接回 Task 结果投递能力之后的完整 Agent Module 输出面，供 Composition Root 装配。 */
export interface AgentModule extends AgentTaskCapabilities {
  readonly cancelRegistry: CancelRegistryPort
  readonly runService: AgentRunServicePort
  readonly chat: ChatUseCasePort
  readonly chatLifecycle: ChatRunLifecyclePort
  readonly sessionQueries: DefaultSessionQueryService
  readonly trajectory: DefaultTrajectoryService
}

/**
 * 先创建 Agent 的无环核心。Task 依赖这些能力创建调度与投递，再由 createAgentModule
 * 把 Task 提供的结果投递 Port 接回普通对话；Agent 不感知 Task 内部实现。
 */
export function createAgentModuleCore(options: {
  readonly database: SqlExecutor
  readonly redis: RedisConnection
  readonly tracer: TracerPort
  readonly idGenerator: IdGenerator
  readonly llmRegistry: LlmProviderRegistry
  readonly toolRegistry: ToolRegistry
  readonly logger: Logger
}): AgentModuleCore {
  const sessionRepository = new PostgresSessionRepository(options.database)
  const messageBuffer = new RedisMessageBuffer(options.redis)
  const cancelRegistry = new RedisCancelRegistry(options.redis)
  const lockRegistry = new RedisSessionLockRegistry(options.redis, {
    nextFencingToken: (): Promise<bigint> =>
      sessionRepository.nextFencingToken(new AbortController().signal),
    onRenewalError: (error): void => options.logger.warn('session lock renewal failed', { error }),
  })
  const executor = new RuntimeAgentExecutor(options.tracer)
  const runtimeState = new RuntimeStateCodec()
  const runFactRepository = new PostgresRunFactRepository(options.database)
  const subExecutionRepository = new PostgresSubExecutionRepository(options.database)
  const subAgentToolFactory = new RuntimeSubAgentToolFactory({
    executor,
    idGenerator: options.idGenerator,
    registry: options.toolRegistry,
    repository: subExecutionRepository,
  })
  const definitionLoader = new DbMainAgentLoader({
    database: options.database,
    registry: options.toolRegistry,
    adapterFactory: options.llmRegistry.adapterFactory(),
    subAgentToolFactory,
  })
  const loader = new PreparedAgentLoader(
    wrapAgentLoader(options.tracer, definitionLoader),
    new SubExecutionRecovery(subExecutionRepository, runtimeState)
  )
  const backgroundExecution = new DefaultBackgroundAgentExecutionService(
    loader,
    executor,
    messageBuffer
  )
  const externalTurnWriter = new DefaultExternalSessionTurnWriter(
    sessionRepository,
    lockRegistry,
    runtimeState
  )
  /** 接回 Task 的结果投递能力后，补齐运行、Chat 与查询用例所需的装配。 */
  function completeAgentModule(
    deliveryQueue: TaskResultDeliveryPort,
    moduleIdGenerator: IdGenerator
  ): AgentModule {
    const runService = new ProductAgentRunService({
      loader,
      executor,
      sessions: new SessionLifecycle(sessionRepository, messageBuffer, lockRegistry),
      messageBuffer,
      deliveryQueue,
      runFacts: runFactRepository,
      logger: options.logger,
    })
    const sessionQueryService = new DefaultSessionQueryService(sessionRepository)
    const chatService = new DefaultChatService({
      runService,
      cancelRegistry,
      idGenerator: moduleIdGenerator,
    })
    return {
      backgroundExecution,
      externalTurnWriter,
      cancelRegistry,
      runService,
      chat: chatService,
      chatLifecycle: chatService,
      sessionQueries: sessionQueryService,
      trajectory: new DefaultTrajectoryService(
        sessionRepository,
        subExecutionRepository,
        runFactRepository,
        options.logger
      ),
    }
  }

  return {
    sessionLocks: lockRegistry,
    backgroundExecution,
    externalTurnWriter,
    complete: completeAgentModule,
  }
}

/** 完成 Agent Module 的用例组装，并向 Composition Root 返回 HTTP 层所需的入站 Port。 */
export function createAgentModule(
  core: AgentModuleCore,
  deliveryQueue: TaskResultDeliveryPort,
  idGenerator: IdGenerator
): AgentModule {
  return core.complete(deliveryQueue, idGenerator)
}
