import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { bootstrapDatabase } from '../../src/app/bootstrap.js'
import type { DatabaseMigrationGatePort } from '../../src/infra/database/migrator.js'
import type { PasswordHasher } from '../../src/modules/identity/service/authentication/port/password-hasher.port.js'
import type { AppConfig } from '../../src/infra/config/config.js'
import type { Logger } from '../../src/infra/logger/logger.js'
import type {
  SqlExecutor,
  SqlQueryResult,
  TransactionalSqlExecutor,
} from '../../src/infra/database/postgres.js'

const SIGNAL = new AbortController().signal

class RecordingDatabase implements TransactionalSqlExecutor {
  public readonly queries: Array<{
    readonly sql: string
    readonly parameters: readonly unknown[]
  }> = []
  public userExists = false

  public query(
    sql: string,
    parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    this.queries.push({ sql, parameters })
    if (sql.includes('SELECT 1 FROM users')) {
      return Promise.resolve({ rows: this.userExists ? [{ '?column?': 1 }] : [], rowCount: 0 })
    }
    return Promise.resolve({ rows: [], rowCount: 1 })
  }

  public transaction<TValue>(
    signal: AbortSignal,
    operation: (transaction: SqlExecutor) => Promise<TValue>
  ): Promise<TValue> {
    signal.throwIfAborted()
    return operation(this)
  }
}

class RecordingMigrator implements DatabaseMigrationGatePort {
  public upCalls = 0
  public statusCalls = 0
  public pending = false

  public up(): Promise<{ readonly groupId: number; readonly migrationNames: readonly string[] }> {
    this.upCalls += 1
    return Promise.resolve({ groupId: 1, migrationNames: ['migration'] })
  }

  public status(): Promise<
    readonly {
      readonly name: string
      readonly comment: string
      readonly status: 'applied' | 'pending'
    }[]
  > {
    this.statusCalls += 1
    return Promise.resolve([
      {
        name: 'migration',
        comment: 'test',
        status: this.pending ? 'pending' : 'applied',
      },
    ])
  }
}

class RecordingHasher implements PasswordHasher {
  public hashes: string[] = []

  public hash(password: string): Promise<string> {
    this.hashes.push(password)
    return Promise.resolve(`hashed:${password}`)
  }

  public verify(): Promise<void> {
    return Promise.resolve()
  }
}

const QUIET_LOGGER: Logger = {
  child(): Logger {
    return this
  },
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
}

void describe('TypeScript database bootstrap', () => {
  void it('runs migrations and seeds the baseline records idempotently', async () => {
    const database = new RecordingDatabase()
    const migrator = new RecordingMigrator()
    const hasher = new RecordingHasher()

    await bootstrapDatabase({
      config: config(true),
      database,
      migrator,
      passwordHasher: hasher,
      logger: QUIET_LOGGER,
      signal: SIGNAL,
    })

    assert.equal(migrator.upCalls, 1)
    assert.equal(migrator.statusCalls, 0)
    assert.deepEqual(hasher.hashes, ['secret'])
    const statements = database.queries.map((query): string => query.sql)
    assert.ok(statements.some((sql): boolean => sql.includes('INSERT INTO api_credentials')))
    assert.ok(statements.some((sql): boolean => sql.includes('INSERT INTO llm_configs')))
    assert.ok(statements.some((sql): boolean => sql.includes('INSERT INTO core_agents')))
    assert.ok(
      statements.some(
        (sql): boolean => sql.includes('array_remove') && sql.includes('sys_tool_ids')
      )
    )
    assert.ok(statements.some((sql): boolean => sql.includes('INSERT INTO users')))
  })

  void it('rejects startup when automatic migration is disabled and schema is stale', async () => {
    const database = new RecordingDatabase()
    const migrator = new RecordingMigrator()
    migrator.pending = true

    await assert.rejects(
      bootstrapDatabase({
        config: config(false),
        database,
        migrator,
        passwordHasher: new RecordingHasher(),
        logger: QUIET_LOGGER,
        signal: SIGNAL,
      }),
      /未应用迁移/u
    )
    assert.equal(database.queries.length, 0)
  })
})

function config(autoMigrate: boolean): AppConfig {
  return {
    server: { host: '127.0.0.1', port: '8080', env: 'local', logFormat: 'text', logLevel: 'info' },
    database: { url: 'postgres://example', autoMigrate },
    redis: { url: 'redis://example' },
    jwt: { secret: 'secret' },
    minio: {
      endpoint: '127.0.0.1:9000',
      accessKey: 'access',
      secretKey: 'secret',
      bucket: 'bucket',
      useSsl: false,
      region: '',
    },
    cors: { origins: 'http://localhost:5173' },
    llm: { apiKey: 'key', baseUrl: 'https://example.test/v1', model: 'model' },
    devUser: {
      username: 'developer',
      password: 'secret',
      displayName: 'Developer',
      email: 'developer@example.test',
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
    observability: { exporter: 'structured', serviceName: 'red-bean-nian-gao', sampleRatio: 1 },
  }
}
