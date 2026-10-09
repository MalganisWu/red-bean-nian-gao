import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import type { MinioStorageConfig } from '../../src/modules/storage/service/object-storage/minio-object-storage.js'
import type { AppConfig } from '../../src/infra/config/config.js'

export const REQUIRED_ENVIRONMENT = 'RBNG_INTEGRATION_REQUIRED'

export const DATABASE_URL_ENVIRONMENT = 'RBNG_INTEGRATION_DATABASE_URL'

export const REDIS_URL_ENVIRONMENT = 'RBNG_INTEGRATION_REDIS_URL'

export const MINIO_ENDPOINT_ENVIRONMENT = 'RBNG_INTEGRATION_MINIO_ENDPOINT'

export const MINIO_ACCESS_KEY_ENVIRONMENT = 'RBNG_INTEGRATION_MINIO_ACCESS_KEY'

export const MINIO_SECRET_KEY_ENVIRONMENT = 'RBNG_INTEGRATION_MINIO_SECRET_KEY'

export const COMPOSE_ENV_FILE_ENVIRONMENT = 'RBNG_COMPOSE_ENV_FILE'

export const unknownRecordSchema = z.record(z.string(), z.unknown())

export async function loadIntegrationDatabaseUrl(): Promise<string | undefined> {
  const explicit = process.env[DATABASE_URL_ENVIRONMENT]
  if (explicit !== undefined && explicit.trim() !== '') return validateDatabaseUrl(explicit)

  const path = process.env[COMPOSE_ENV_FILE_ENVIRONMENT]
  if (path === undefined || path.trim() === '') return undefined
  const values = parseDotEnv(await readFile(path, 'utf8'))
  const url = new URL('postgres://127.0.0.1')
  url.username = requiredValue(values, 'POSTGRES_USER')
  url.password = requiredValue(values, 'POSTGRES_PASSWORD')
  url.hostname = '127.0.0.1'
  url.port = values.get('POSTGRES_PORT')?.trim() || '5432'
  url.pathname = `/${requiredValue(values, 'POSTGRES_DB')}`
  url.searchParams.set('sslmode', 'disable')
  return url.toString()
}

export async function loadIntegrationRedisUrl(): Promise<string | undefined> {
  const explicit = process.env[REDIS_URL_ENVIRONMENT]
  if (explicit !== undefined && explicit.trim() !== '') return validateRedisUrl(explicit)

  const path = process.env[COMPOSE_ENV_FILE_ENVIRONMENT]
  if (path === undefined || path.trim() === '') return undefined
  const values = parseDotEnv(await readFile(path, 'utf8'))
  const url = new URL('redis://127.0.0.1')
  url.password = requiredValue(values, 'REDIS_PASSWORD')
  url.hostname = '127.0.0.1'
  url.port = values.get('REDIS_PORT')?.trim() || '6379'
  url.pathname = '/15'
  return url.toString()
}

export async function loadIntegrationMinioConfig(): Promise<MinioStorageConfig | undefined> {
  const explicitEndpoint = process.env[MINIO_ENDPOINT_ENVIRONMENT]
  const explicitAccessKey = process.env[MINIO_ACCESS_KEY_ENVIRONMENT]
  const explicitSecretKey = process.env[MINIO_SECRET_KEY_ENVIRONMENT]
  if (
    explicitEndpoint !== undefined &&
    explicitEndpoint.trim() !== '' &&
    explicitAccessKey !== undefined &&
    explicitAccessKey.trim() !== '' &&
    explicitSecretKey !== undefined &&
    explicitSecretKey.trim() !== ''
  ) {
    return {
      endpoint: explicitEndpoint,
      accessKey: explicitAccessKey,
      secretKey: explicitSecretKey,
      bucket: 'red-bean-nian-gao',
      useSsl: false,
      region: '',
    }
  }

  const path = process.env[COMPOSE_ENV_FILE_ENVIRONMENT]
  if (path === undefined || path.trim() === '') return undefined
  const values = parseDotEnv(await readFile(path, 'utf8'))
  return {
    endpoint: `127.0.0.1:${values.get('MINIO_API_PORT')?.trim() || '9000'}`,
    accessKey: requiredValue(values, 'MINIO_ROOT_USER'),
    secretKey: requiredValue(values, 'MINIO_ROOT_PASSWORD'),
    bucket: 'red-bean-nian-gao',
    useSsl: false,
    region: '',
  }
}

export function parseDotEnv(source: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (const originalLine of source.split(/\r?\n/u)) {
    const line = originalLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`无效 Compose env 行: ${line}`)
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

export function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)?.trim()
  if (value === undefined || value === '') throw new Error(`${key} 未在 Compose env 中设置`)
  return value
}

export function validateDatabaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${DATABASE_URL_ENVIRONMENT} 必须是 PostgreSQL URL`)
  }
  if (databaseName(value) === '') throw new Error(`${DATABASE_URL_ENVIRONMENT} 必须包含数据库名`)
  return value
}

export function validateRedisUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`${REDIS_URL_ENVIRONMENT} 必须是 Redis URL`)
  }
  return value
}

export function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//u, '')
}

export function withDatabase(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}

export function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) throw new Error('unsafe PostgreSQL identifier')
  return `"${value}"`
}

export function stringField(value: unknown, field: string): string {
  const parsed = unknownRecordSchema.safeParse(value)
  if (!parsed.success) throw new Error(`invalid PostgreSQL row for ${field}`)
  const fieldValue = parsed.data[field]
  if (typeof fieldValue !== 'string') throw new Error(`invalid PostgreSQL ${field}`)
  return fieldValue
}

export async function waitForAbort(
  signal: AbortSignal,
  timeoutMilliseconds: number
): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout((): void => {
      reject(new Error('timed out waiting for cross-instance cancellation'))
    }, timeoutMilliseconds)
    signal.addEventListener(
      'abort',
      (): void => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
  })
}

export async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const loginResponseSchema = z.object({
  code: z.literal(200),
  data: z.object({ token: z.string().min(1) }),
})

export const sessionListResponseSchema = z.object({
  code: z.literal(200),
  data: z.object({ sessions: z.array(z.object({ id: z.string().min(1) })) }),
})

export function applicationConfig(
  databaseUrl: string,
  redisUrl: string,
  minio: MinioStorageConfig,
  port: number,
  llmPort: number
): AppConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: String(port),
      env: 'test',
      logFormat: 'json',
      logLevel: 'error',
    },
    database: { url: databaseUrl, autoMigrate: true },
    redis: { url: redisUrl },
    jwt: { secret: 'integration-test-secret' },
    minio: { ...minio, bucket: `rbng-http-${String(process.pid)}` },
    cors: { origins: 'http://localhost:5173' },
    llm: {
      apiKey: 'integration-key',
      baseUrl: `http://127.0.0.1:${String(llmPort)}/v1`,
      model: 'integration-model',
    },
    devUser: {
      username: 'integration-user',
      password: 'integration-password',
      displayName: 'Integration User',
      email: 'integration@example.test',
    },
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
      exporter: 'slog',
      serviceName: 'red-bean-nian-gao-http-integration',
      sampleRatio: 1,
    },
  }
}

export function createMockLlmServer(): Server {
  return createServer((request, response): void => {
    request.resume()
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      'data: {"choices":[{"delta":{"content":"集成响应"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
        'data: [DONE]\n\n'
    )
  })
}

export async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no TCP address')
  return address.port
}

export async function reservePort(): Promise<number> {
  const server = createServer()
  const port = await listenOnRandomPort(server)
  await closeServer(server)
  return port
}

export function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject): void => {
    server.close((error): void => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

export async function waitForHealthy(baseUrl: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    signal.throwIfAborted()
    try {
      const response = await fetch(`${baseUrl}/health`, { signal })
      if (response.ok) return
    } catch {
      // The listener may still be opening.
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error('TypeScript application did not become healthy')
}
