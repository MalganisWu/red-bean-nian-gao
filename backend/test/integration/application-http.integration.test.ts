import assert from 'node:assert/strict'
import { it } from 'node:test'
import { buildApplication } from '../../src/app/composition-root.js'
import { connectPostgres } from '../../src/infra/database/postgres.js'
import type { AppConfig } from '../../src/infra/config/config.js'
import { isSessionTrajectory } from '@red-bean/api-contract'

import {
  REQUIRED_ENVIRONMENT,
  loadIntegrationDatabaseUrl,
  loadIntegrationRedisUrl,
  loadIntegrationMinioConfig,
  databaseName,
  withDatabase,
  quoteIdentifier,
  loginResponseSchema,
  sessionListResponseSchema,
  applicationConfig,
  createMockLlmServer,
  listenOnRandomPort,
  reservePort,
  closeServer,
  waitForHealthy,
} from './integration-environment-test-support.js'

/** 信封解包用的最小结构守卫。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

void it('builds, starts, and gracefully drains the complete TypeScript application', async (test) => {
  const databaseUrl = await loadIntegrationDatabaseUrl()
  const redisUrl = await loadIntegrationRedisUrl()
  const minio = await loadIntegrationMinioConfig()
  if (databaseUrl === undefined || redisUrl === undefined || minio === undefined) {
    const message = '完整应用集成环境未设置'
    if (process.env[REQUIRED_ENVIRONMENT] === '1') throw new Error(message)
    test.skip(`${message}，跳过集成测试`)
    return
  }

  const config: AppConfig = {
    server: {
      host: '127.0.0.1',
      port: '0',
      env: 'test',
      logFormat: 'json',
      logLevel: 'error',
    },
    database: { url: databaseUrl, autoMigrate: true },
    redis: { url: redisUrl },
    jwt: { secret: 'integration-test-secret' },
    minio,
    cors: { origins: 'http://localhost:5173' },
    llm: { apiKey: '', baseUrl: 'https://api.example.test/v1', model: 'test-model' },
    devUser: { username: '', password: '', displayName: '', email: '' },
    scheduledTask: {
      maxRetries: 3,
      retryInterval: '5m',
      timezone: 'Asia/Shanghai',
      scanInterval: '1m',
      batchSize: 100,
      maxConcurrent: 4,
      executionTimeout: '15m',
    },
    observability: {
      exporter: 'structured',
      serviceName: 'red-bean-nian-gao-integration',
      sampleRatio: 1,
    },
  }
  const startup = AbortSignal.timeout(60_000)
  const application = await buildApplication(config, startup)
  const processController = new AbortController()
  const stop = setTimeout((): void => processController.abort(), 100)
  try {
    await application.run(processController.signal)
  } finally {
    clearTimeout(stop)
  }
})

void it('serves login, streaming chat, and persisted sessions through the complete application', async (test) => {
  const databaseUrl = await loadIntegrationDatabaseUrl()
  const redisUrl = await loadIntegrationRedisUrl()
  const minio = await loadIntegrationMinioConfig()
  if (databaseUrl === undefined || redisUrl === undefined || minio === undefined) {
    const message = '完整 HTTP 集成环境未设置'
    if (process.env[REQUIRED_ENVIRONMENT] === '1') throw new Error(message)
    test.skip(`${message}，跳过集成测试`)
    return
  }

  const signal = AbortSignal.timeout(60_000)
  const admin = await connectPostgres(withDatabase(databaseUrl, databaseName(databaseUrl)), signal)
  const database = `rbng_http_${String(process.pid)}_${String(Date.now())}`
  const mockLlm = createMockLlmServer()
  const processController = new AbortController()
  let applicationRun: Promise<void> | undefined
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`, [], signal)
    const llmPort = await listenOnRandomPort(mockLlm)
    const applicationPort = await reservePort()
    const config = applicationConfig(
      withDatabase(databaseUrl, database),
      redisUrl,
      minio,
      applicationPort,
      llmPort
    )
    const application = await buildApplication(config, signal)
    applicationRun = application.run(processController.signal)
    const baseUrl = `http://127.0.0.1:${String(applicationPort)}`
    await waitForHealthy(baseUrl, signal)

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'integration-user', password: 'integration-password' }),
      signal,
    })
    assert.equal(login.status, 200)
    const loginBody = loginResponseSchema.parse(await login.json())
    const chat = await fetch(`${baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${loginBody.data.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
      signal,
    })
    assert.equal(chat.status, 200)
    const stream = await chat.text()
    assert.match(stream, /event: start\ndata: \{"request_id":/u)
    assert.match(stream, /event: token\ndata: \{"content":"集成响应"\}/u)
    assert.match(stream, /event: done\ndata: \{"tokens_used":3/u)

    const sessions = await fetch(`${baseUrl}/api/sessions`, {
      headers: { authorization: `Bearer ${loginBody.data.token}` },
      signal,
    })
    assert.equal(sessions.status, 200)
    const sessionsBody = sessionListResponseSchema.parse(await sessions.json())
    const sessionId = sessionsBody.data.sessions[0]?.id
    assert.notEqual(sessionId, undefined)
    if (sessionId === undefined) throw new Error('chat did not persist a session')
    const detail = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${loginBody.data.token}` },
      signal,
    })
    assert.equal(detail.status, 200)
    assert.match(await detail.text(), /集成响应/u)

    /* 会话轨迹端点：真实 PostgreSQL 持久化 → 投影 → 共享契约运行时校验 */
    const trajectory = await fetch(`${baseUrl}/api/sessions/${sessionId}/trajectory`, {
      headers: { authorization: `Bearer ${loginBody.data.token}` },
      signal,
    })
    assert.equal(trajectory.status, 200)
    const trajectoryBody: unknown = await trajectory.json()
    assert.ok(isRecord(trajectoryBody))
    assert.ok(isRecord(trajectoryBody['data']))
    assert.equal(isSessionTrajectory(trajectoryBody['data']), true)
  } finally {
    processController.abort()
    if (applicationRun !== undefined) await applicationRun.catch((): void => undefined)
    await closeServer(mockLlm)
    // application.run() 返回后必须已经释放全部连接；普通 DROP 同时验证这一所有权约束。
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`, [], signal)
    await admin.close()
  }
})
