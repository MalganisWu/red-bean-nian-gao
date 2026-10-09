import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  API_ROUTES,
  SSE_EVENT_TYPES,
  isCardEvent,
  isCompactionEvent,
  isDoneEvent,
  isErrorEvent,
  isHeartbeatEvent,
  isReasonEvent,
  isStartEvent,
  isStatusEvent,
  isSubAgentEnvelope,
  isTokenEvent,
  isToolResultEvent,
  isToolStartEvent,
  type SSEEventType,
} from '@red-bean/api-contract'

import { STATUS_CODES, type JsonValue } from 'red-bean-qing-tuan/pipeline'
import type { IdGenerator } from '../../src/shared/id/id-generator.js'

import { serializeSseEvent } from '../../src/modules/agent/chat/controller/chat-event-presenter.js'
import type { ProductStreamEvent } from '../../src/modules/agent/run/model/agent-run.js'
import type { ChatUseCasePort } from '../../src/modules/agent/chat/port/chat-use-case.port.js'
import type { StartedChatRun } from '../../src/modules/agent/chat/model/chat-command.js'
import type { ChatRunHandle } from '../../src/modules/agent/chat/stream/chat-run-handle.js'
import { HealthService } from '../../src/modules/system/service/health/default-health-service.js'
import { createHttpServer } from '../../src/shared/http/fastify-http-boundary.js'
import { routeCatalogChecker } from '../../src/shared/http/route-catalog-check.js'
import { registerApplicationRoutes } from '../../src/app/http-routes.js'
import { TestPostgresTaskRepositories as PostgresTaskRepository } from '../helpers/postgres-task-repositories.js'
import { TaskCommandService } from '../../src/modules/task/service/cases/task-command-service.js'
import { TaskQueryService } from '../../src/modules/task/service/cases/task-query-service.js'
import {
  BcryptPasswordHasher,
  JwtAuthService,
} from '../../src/modules/identity/service/authentication/default-auth-service.js'
import { IdentityProfileService } from '../../src/modules/identity/service/application/profile/identity-profile-service.js'
import { IdentityRegistrationService } from '../../src/modules/identity/service/application/registration/identity-registration-service.js'
import { PostgresUserRepository } from '../../src/modules/identity/service/user-repository/postgres-user-repository.js'
import { MemorySessionStore } from '../../src/modules/agent/session/repository/adapter/memory-session-repository.js'
import type { RunFactRepository } from '../../src/modules/agent/run-facts/port/run-fact-repository.port.js'
import { DefaultSessionQueryService } from '../../src/modules/agent/session/query/service/default-session-query-service.js'
import { DefaultTrajectoryService } from '../../src/modules/agent/trajectory/service/default-trajectory-service.js'
import type { SubExecutionRepository } from '../../src/modules/agent/subagent/repository/port/sub-execution-repository.port.js'
import { MinioObjectStorage } from '../../src/modules/storage/service/object-storage/minio-object-storage.js'
import { StorageService } from '../../src/modules/storage/service/application/storage-service.js'
import type { SqlQueryResult, TransactionalSqlExecutor } from '../../src/infra/database/postgres.js'

interface RouteKey {
  readonly method: string
  readonly path: string
}

class FixedIds implements IdGenerator {
  public generate(prefix: string): string {
    return `${prefix}_1`
  }
}

/** 路由契约测试只需空读的子执行仓储桩。 */
const EMPTY_SUB_EXECUTIONS: SubExecutionRepository = {
  create: () => Promise.resolve(),
  getById: () => Promise.resolve(undefined),
  listPending: () => Promise.resolve([]),
  listBySession: () => Promise.resolve([]),
  claimPending: () => Promise.reject(new Error('无待恢复子执行')),
  claimResume: () => Promise.resolve(),
  renewResumeLease: () => Promise.resolve(),
  appendRecoveryMessage: () => Promise.resolve(),
  update: () => Promise.resolve(),
}

const EMPTY_RUN_FACTS: RunFactRepository = {
  create: () => Promise.reject(new Error('路由对账不发起运行')),
  appendFact: () => Promise.resolve(),
  finalize: () => Promise.resolve(),
  listBySession: () => Promise.resolve([]),
}

class UnusedDatabase implements TransactionalSqlExecutor {
  public query(): Promise<SqlQueryResult> {
    return Promise.reject(new Error('contract registration must not query PostgreSQL'))
  }

  public transaction<TValue>(): Promise<TValue> {
    return Promise.reject(new Error('contract registration must not start a transaction'))
  }
}

const UNUSED_CHAT: ChatUseCasePort = {
  start(): Promise<StartedChatRun> {
    const events = eventStream([])
    const handle: ChatRunHandle = {
      runId: 'unused',
      sessionId: 'unused',
      events,
      completion: Promise.resolve({ status: 'completed' }),
      close: (): Promise<void> => Promise.resolve(),
      [Symbol.asyncIterator](): AsyncIterator<ProductStreamEvent> {
        return events[Symbol.asyncIterator]()
      },
    }
    return Promise.resolve({
      start: { type: 'start', requestId: 'unused', sessionId: 'unused', traceId: 'unused' },
      handle,
    })
  },
  answer(): Promise<StartedChatRun> {
    return this.start({
      userId: 'unused',
      traceId: 'unused',
      signal: new AbortController().signal,
      messages: [],
    })
  },
  cancel(): Promise<void> {
    return Promise.resolve()
  },
}

async function* eventStream(
  events: readonly ProductStreamEvent[]
): AsyncGenerator<ProductStreamEvent> {
  await Promise.resolve()
  for (const event of events) yield event
}

async function contractDocument(): Promise<string> {
  return readFile(path.resolve(process.cwd(), '../docs/contracts/api.md'), 'utf8')
}

function documentedRoutes(document: string): readonly RouteKey[] {
  const block = betweenMarkers(document, 'ROUTE-TABLE')
  const routes: RouteKey[] = []
  for (const line of block.split('\n')) {
    const columns = line.split('|').map((column): string => column.trim())
    const method = columns[1]
    const routePath = columns[2]
    if (
      method === undefined ||
      routePath === undefined ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      !routePath.startsWith('/')
    ) {
      continue
    }
    routes.push({ method, path: routePath })
  }
  return routes
}

function documentedSseGolden(document: string): Readonly<Record<string, JsonValue>> {
  const fenced = betweenMarkers(document, 'SSE-GOLDEN').trim()
  const json = fenced.replace(/^```json\s*/u, '').replace(/\s*```$/u, '')
  const parsed: unknown = JSON.parse(json)
  if (!isJsonRecord(parsed)) throw new Error('SSE golden must be a JSON object')
  return parsed
}

function betweenMarkers(document: string, name: string): string {
  const startMarker = `<!-- ${name}-START -->`
  const endMarker = `<!-- ${name}-END -->`
  const start = document.indexOf(startMarker)
  const end = document.indexOf(endMarker)
  if (start < 0 || end <= start) throw new Error(`missing ${name} markers`)
  return document.slice(start + startMarker.length, end)
}

function routeKey(route: RouteKey): string {
  return `${route.method} ${route.path}`
}

async function registeredRoutes(): Promise<void> {
  const database = new UnusedDatabase()
  const ids = new FixedIds()
  const userRepository = new PostgresUserRepository(database)
  const passwordHasher = new BcryptPasswordHasher(4)
  const authService = new JwtAuthService({
    userRepository,
    passwordHasher,
    secret: 'contract-test-secret',
  })
  const registration = new IdentityRegistrationService({
    users: userRepository,
    passwordHasher,
    idGenerator: ids,
  })
  const profiles = new IdentityProfileService({ users: userRepository })
  const taskRepository = new PostgresTaskRepository(database)
  const taskQueries = new TaskQueryService({
    taskRepository,
    taskListRepository: taskRepository,
    viewStateRepository: taskRepository,
  })
  const taskCommands = new TaskCommandService({
    commandRepository: taskRepository,
    queryRepository: taskRepository,
    viewStateRepository: taskRepository,
  })
  const storage = new MinioObjectStorage({
    endpoint: '127.0.0.1:9000',
    accessKey: 'unused',
    secretKey: 'unused',
    bucket: 'contract-test',
    useSsl: false,
    region: '',
  })
  const health = new HealthService({
    database: (): Promise<void> => Promise.resolve(),
    redis: (): Promise<void> => Promise.resolve(),
    storage: (): Promise<void> => Promise.resolve(),
  })
  // 启动期目录对账：完成应用路由注册后立即校验，漏注册/裸注册会抛错。
  const server = createHttpServer({ idGenerator: ids })
  const routeCatalog = routeCatalogChecker(server)
  registerApplicationRoutes(server, {
    health,
    chat: {
      chat: UNUSED_CHAT,
      authService,
    },
    sessions: {
      queries: new DefaultSessionQueryService(new MemorySessionStore()),
      authService,
    },
    trajectories: {
      trajectory: new DefaultTrajectoryService(
        new MemorySessionStore(),
        EMPTY_SUB_EXECUTIONS,
        EMPTY_RUN_FACTS
      ),
      authService,
    },
    users: { registration, profiles, authService },
    storage: { storageService: new StorageService(storage), authService },
    tasks: {
      queries: taskQueries,
      commands: taskCommands,
      authService,
    },
  })
  routeCatalog.verify()
  await server.ready()
  await server.close()
}

function canonicalEvents(): Readonly<Record<SSEEventType, ProductStreamEvent>> {
  return {
    start: {
      type: 'start',
      requestId: 'RUN_1',
      sessionId: 'SES_1',
      traceId: '0123456789abcdef0123456789abcdef',
    },
    token: { type: 'token', content: '你' },
    status: {
      type: 'status',
      code: STATUS_CODES.LLM_RETRY,
      attempt: 2,
      maxAttempts: 3,
      content: 'LLM 请求失败，正在进行第 1/2 次重试...',
    },
    reason: { type: 'reason', content: '分析问题', step: 1, timestamp: 1_722_751_200_000 },
    tool_start: {
      type: 'tool_start',
      toolName: 'get_weather',
      callId: 'call_1',
      params: { city: '上海' },
    },
    tool_result: {
      type: 'tool_result',
      toolName: 'get_weather',
      callId: 'call_1',
      content: '{}',
      error: 'upstream timeout',
    },
    card: {
      type: 'card',
      interactionId: 'call_ask',
      status: 'pending',
      questions: [{ id: 'q1', text: '继续吗？', options: ['继续', '停止'], select: 'single' }],
    },
    done: { type: 'done', tokensUsed: 42, sessionId: 'SES_1' },
    heartbeat: { type: 'heartbeat', timestamp: 1_722_751_200_000 },
    error: { type: 'error', code: 5000, message: '服务器内部错误' },
    compaction: {
      type: 'compaction',
      trigger: 'auto',
      preTokens: 10_000,
      postTokens: 3_000,
      messagesSummarized: 12,
    },
    agent_event: {
      type: 'agent_event',
      agentId: 'agent_child',
      agentName: '研究员',
      executionId: 'exec_1',
      parentCallId: 'call_parent',
      eventType: 'token',
      event: { type: 'token', content: '结果' },
    },
  }
}

function payloadFromFrame(frame: string): JsonValue {
  const data = frame
    .split('\n')
    .find((line): boolean => line.startsWith('data: '))
    ?.slice('data: '.length)
  if (data === undefined) throw new Error('SSE frame has no data line')
  const parsed: unknown = JSON.parse(data)
  if (!isJsonValue(parsed)) throw new Error('SSE frame data must be JSON')
  return parsed
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonRecord(value)
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  )
}

const EVENT_GUARDS: Readonly<Record<SSEEventType, (value: unknown) => boolean>> = {
  [SSE_EVENT_TYPES.START]: isStartEvent,
  [SSE_EVENT_TYPES.TOKEN]: isTokenEvent,
  [SSE_EVENT_TYPES.STATUS]: isStatusEvent,
  [SSE_EVENT_TYPES.REASON]: isReasonEvent,
  [SSE_EVENT_TYPES.TOOL_START]: isToolStartEvent,
  [SSE_EVENT_TYPES.TOOL_RESULT]: isToolResultEvent,
  [SSE_EVENT_TYPES.CARD]: isCardEvent,
  [SSE_EVENT_TYPES.DONE]: isDoneEvent,
  [SSE_EVENT_TYPES.HEARTBEAT]: isHeartbeatEvent,
  [SSE_EVENT_TYPES.ERROR]: isErrorEvent,
  [SSE_EVENT_TYPES.COMPACTION]: isCompactionEvent,
  [SSE_EVENT_TYPES.AGENT_EVENT]: isSubAgentEnvelope,
}

void describe('TypeScript API contract', () => {
  void it('registers exactly the routes declared by the executable shared contract', async () => {
    assert.equal(Object.values(API_ROUTES).length, 31)
    // registeredRoutes 内部执行 routeCatalog.verify()：实际注册表与目录双向对账，漂移即抛错
    await registeredRoutes()
  })

  void it('keeps the human-readable route table synchronized with the shared contract', async () => {
    const documented = documentedRoutes(await contractDocument())
      .map(routeKey)
      .toSorted()
    assert.deepEqual(documented, Object.values(API_ROUTES).map(routeKey).toSorted())
  })

  void it('serializes every shared SSE event into a payload accepted by its shared guard', () => {
    const events = canonicalEvents()
    assert.deepEqual(Object.keys(events).toSorted(), Object.values(SSE_EVENT_TYPES).toSorted())
    for (const name of Object.values(SSE_EVENT_TYPES)) {
      const event = events[name]
      assert.equal(event.type, name)
      assert.equal(EVENT_GUARDS[name](payloadFromFrame(serializeSseEvent(event))), true)
    }
  })

  void it('keeps the human-readable SSE examples synchronized with serialization', async () => {
    const expected = documentedSseGolden(await contractDocument())
    const events = canonicalEvents()
    assert.deepEqual(Object.keys(events).toSorted(), Object.keys(expected).toSorted())
    for (const [name, event] of Object.entries(events)) {
      assert.equal(event.type, name)
      assert.deepEqual(payloadFromFrame(serializeSseEvent(event)), expected[name])
    }
  })
})
