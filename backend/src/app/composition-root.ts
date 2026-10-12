import { createHttpServer } from '../shared/http/fastify-http-boundary.js'
import { createSystemModule, type VersionInfo } from '../modules/system/public-api.js'
import { LlmProviderRegistry } from '../platform/llm/registry/llm-registry.js'
import { OPENAI_PROVIDER_PLUGIN } from '../platform/llm/provider/openai-provider.js'
import { productBuiltinProvider } from '../platform/tool/provider/product-tool-provider.js'
import { ToolRegistry } from '../platform/tool/registry/tool-registry.js'
import { runtimeBuiltinProvider } from '../platform/tool/provider/runtime-tool-provider.js'
import { createHostTools } from '../platform/tool/provider/host-tools.js'
import type { AppConfig } from '../infra/config/config.js'
import { connectPostgres } from '../infra/database/postgres.js'
import { TimestampIdGenerator } from '../infra/id-generator.js'
import { createLogger, type Logger } from '../infra/logger/logger.js'
import { createObservabilityProvider } from '../infra/observability/provider.js'
import { newTraceId } from '../infra/observability/structured-log-tracer.js'
import { W3CTraceContextExtractor } from '../infra/observability/w3c-propagator.js'
import { connectRedis } from '../infra/redis/redis.js'
import {
  createAgentModule,
  createAgentModuleCore,
  createAskUserTool,
} from '../modules/agent/public-api.js'
import { createIdentityModule } from '../modules/identity/public-api.js'
import { createStorageModule } from '../modules/storage/public-api.js'
import { createTaskModule, createTaskPersistence } from '../modules/task/public-api.js'
import { bootstrapDatabase } from './bootstrap.js'
import { FastifyHttpServer } from './fastify-http-server.js'
import { registerApplicationRoutes } from './http-routes.js'
import { routeCatalogChecker } from '../shared/http/route-catalog-check.js'
import { ServerApplication, buildManaged } from './server-application.js'

/** 组装选项；目前只有构建版本信息一项可注入。 */
export interface BuildApplicationOptions {
  readonly version?: VersionInfo | undefined
}

/**
 * 全局 Composition Root 只连接基础设施、平台能力和业务 Module。
 * Module 内部的 Port → 实现映射分别位于对应的 `*.module.ts`。
 *
 * 五步的**顺序本身是依赖关系**，不是编号习惯：
 * 1. 基础设施先立起来，每建一个就把关闭责任登记到 lifecycle；
 * 2. Identity 要先于 bootstrap，因为建默认用户需要它的密码散列；
 * 3. Provider 注册表在启动期一次建好并封闭，运行期不再改能力图；
 * 4. Agent 与 Task 互为依赖（Task 用 Agent 执行、Agent 用 Task 投递），
 *    因此拆成 core → task → agent 三步，避免循环构造；
 * 5. HTTP 层最后组装，且只拿到各 Module 输出的 Port 绑定表，不直接接触实现。
 *
 * 整个函数体跑在 `buildManaged` 里：中途任一步失败，前面已建好的资源会被按登记顺序反向释放，
 * 不会留下半启动的进程。
 */
export function buildApplication(
  config: AppConfig,
  startupSignal: AbortSignal,
  options: BuildApplicationOptions = {}
): Promise<ServerApplication> {
  return buildManaged(async (lifecycle): Promise<ServerApplication> => {
    // 1. 建立进程级基础设施，并把关闭责任登记到统一生命周期。
    const logger = createLogger({ format: config.server.logFormat, level: config.server.logLevel })
    const database = await connectPostgres(config.database.url, startupSignal)
    lifecycle.onClose((): Promise<void> => database.close())
    const redis = await connectRedis(config.redis.url, startupSignal)
    lifecycle.onClose((): Promise<void> => redis.close())
    const idGenerator = new TimestampIdGenerator()

    // 2. 先创建独立 Module；数据库初始化复用 Identity Module 的密码散列实现。
    const identity = createIdentityModule(database, idGenerator, config.jwt.secret)
    const storage = await createStorageModule(config.minio, startupSignal)
    await bootstrapDatabase({
      config,
      database,
      passwordHasher: identity.passwordHasher,
      logger,
      signal: startupSignal,
    })

    // 3. 平台 Provider 在启动期注册并封闭，运行期间不动态替换能力图。
    const observability = createObservabilityProvider(
      {
        exporter: config.observability.exporter,
        serviceName: config.observability.serviceName,
        environment: config.server.env,
        sampleRatio: config.observability.sampleRatio,
      },
      { logSink: traceLogSink(logger) }
    )
    lifecycle.onClose((): Promise<void> => observability.shutdown())
    const tracer = observability.tracer()
    const taskPersistence = createTaskPersistence(database)
    const llmRegistry = new LlmProviderRegistry([OPENAI_PROVIDER_PLUGIN])
    const toolRegistry = new ToolRegistry([
      runtimeBuiltinProvider(createHostTools()),
      productBuiltinProvider([
        createAskUserTool(),
        taskPersistence.createManagementTool(idGenerator, config.scheduledTask.timezone),
      ]),
    ])

    // 4. Agent 与 Task 仅在这里交叉连接：Task 使用 Agent 执行能力，Agent 使用 Task 投递能力。
    const agentCore = createAgentModuleCore({
      database,
      redis,
      tracer,
      idGenerator,
      llmRegistry,
      toolRegistry,
      logger,
    })
    const tasks = createTaskModule({
      persistence: taskPersistence,
      redis,
      agent: agentCore,
      idGenerator,
      tracer,
      logger,
      config,
    })
    const agent = createAgentModule(agentCore, tasks.deliveryQueue, idGenerator)
    lifecycle.onClose((signal): Promise<void> => agent.chatLifecycle.shutdown(signal))

    // 5. HTTP 层只接收各 Module 输出的 Port 绑定表。
    const system = createSystemModule(
      {
        database: async (signal): Promise<void> => {
          await database.query('SELECT 1', [], signal)
        },
        redis: (signal): Promise<void> => redis.ping(signal),
        storage: async (signal): Promise<void> => {
          await storage.health.check(signal)
        },
      },
      options.version
    )
    const fastifyServer = createHttpServer({
      idGenerator,
      corsOrigins: config.cors.origins,
      tracer,
      traceIdGenerator: newTraceId,
      traceContextExtractor: new W3CTraceContextExtractor(),
    })
    // 启动期路由目录对账：先挂收集钩子，注册完成后立即校验（漏注册/裸注册即启动失败）。
    const routeCatalog = routeCatalogChecker(fastifyServer)
    registerApplicationRoutes(fastifyServer, {
      health: system.health,
      chat: { chat: agent.chat, authService: identity.authService },
      sessions: {
        queries: agent.sessionQueries,
        authService: identity.authService,
      },
      trajectories: {
        trajectory: agent.trajectory,
        authService: identity.authService,
      },
      storage: { storageService: storage.storageService, authService: identity.authService },
      tasks: {
        queries: tasks.queryService,
        commands: tasks.commandService,
        authService: identity.authService,
      },
      users: {
        registration: identity.registrationService,
        profiles: identity.profileService,
        authService: identity.authService,
      },
    })
    routeCatalog.verify()

    return new ServerApplication({
      server: new FastifyHttpServer(fastifyServer, {
        host: config.server.host,
        port: config.server.port,
      }),
      lifecycle,
      health: system.health,
      backgroundTasks: tasks.backgroundTasks,
      shutdownTasks: [(signal): Promise<void> => agent.chatLifecycle.shutdown(signal)],
    })
  })
}

/**
 * 把中性观测层的日志出口接到项目 logger 上。
 * 两者的级别名集合略有差异（观测层只有 debug/info/error，没有 warn），
 * 这里按同名直传；span 因此与业务日志进同一条流，按 trace_id 一次检索即可对齐。
 */
function traceLogSink(logger: Logger): {
  readonly write: (record: {
    readonly level: 'debug' | 'info' | 'error'
    readonly message: string
    readonly fields: Readonly<Record<string, string | number>>
  }) => void
} {
  return { write: (record): void => logger[record.level](record.message, record.fields) }
}
