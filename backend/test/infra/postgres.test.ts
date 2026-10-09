import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PostgresDatabase,
  connectPostgres,
  type PostgresPoolDriver,
  type PostgresPoolDriverFactory,
  type PostgresPoolOptions,
  type SqlConnectionDriver,
  type SqlQueryResult,
} from '../../src/infra/database/postgres.js'

class RecordingConnection implements SqlConnectionDriver {
  public readonly statements: string[] = []
  public releaseCalls = 0
  public failOn = ''

  public query(sql: string): Promise<SqlQueryResult> {
    this.statements.push(sql)
    if (sql === this.failOn) return Promise.reject(new Error(`failed ${sql}`))
    return Promise.resolve({ rows: [], rowCount: 0 })
  }

  public release(): void {
    this.releaseCalls += 1
  }
}

class RecordingPool implements PostgresPoolDriver {
  public readonly statements: string[] = []
  public readonly connection = new RecordingConnection()
  public endCalls = 0
  public pingError: Error | undefined

  public query(sql: string): Promise<SqlQueryResult> {
    this.statements.push(sql)
    if (this.pingError !== undefined) return Promise.reject(this.pingError)
    return Promise.resolve({ rows: [], rowCount: 1 })
  }

  public connect(): Promise<SqlConnectionDriver> {
    return Promise.resolve(this.connection)
  }

  public end(): Promise<void> {
    this.endCalls += 1
    return Promise.resolve()
  }
}

class RecordingFactory implements PostgresPoolDriverFactory {
  public options: PostgresPoolOptions | undefined
  public readonly pool = new RecordingPool()

  public create(options: PostgresPoolOptions): PostgresPoolDriver {
    this.options = options
    return this.pool
  }
}

void describe('PostgreSQL infrastructure', () => {
  void it('rejects an empty database URL', async () => {
    await assert.rejects(
      connectPostgres('', AbortSignal.timeout(1_000), new RecordingFactory()),
      /DATABASE_URL 未设置/u
    )
  })

  void it('uses the bounded pool settings and verifies the connection', async () => {
    const factory = new RecordingFactory()
    const database = await connectPostgres(
      'postgres://user:password@localhost/database',
      AbortSignal.timeout(1_000),
      factory
    )

    assert.deepEqual(factory.options, {
      connectionString: 'postgres://user:password@localhost/database',
      maxConnections: 20,
      minConnections: 5,
      maxLifetimeSeconds: 1_800,
      idleTimeoutMilliseconds: 300_000,
    })
    assert.deepEqual(factory.pool.statements, ['SELECT 1'])
    await database.close()
    await database.close()
    assert.equal(factory.pool.endCalls, 1)
  })

  void it('closes a failed pool and preserves the connection cause', async () => {
    const factory = new RecordingFactory()
    factory.pool.pingError = new Error('connection refused')

    await assert.rejects(
      connectPostgres(
        'postgres://user:password@localhost/database',
        AbortSignal.timeout(1_000),
        factory
      ),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /数据库连接失败: connection refused/u)
        assert.equal(error.cause, factory.pool.pingError)
        return true
      }
    )
    assert.equal(factory.pool.endCalls, 1)
  })

  void it('commits successful transactions and rolls back failures', async () => {
    const pool = new RecordingPool()
    const database = new PostgresDatabase(pool)
    const result = await database.transaction(AbortSignal.timeout(1_000), async (transaction) => {
      await transaction.query(
        'INSERT INTO example VALUES ($1)',
        ['value'],
        AbortSignal.timeout(1_000)
      )
      return 'done'
    })

    assert.equal(result, 'done')
    assert.deepEqual(pool.connection.statements, [
      'BEGIN',
      'INSERT INTO example VALUES ($1)',
      'COMMIT',
    ])
    assert.equal(pool.connection.releaseCalls, 1)

    pool.connection.statements.length = 0
    pool.connection.failOn = 'UPDATE example SET value = $1'
    await assert.rejects(
      database.transaction(AbortSignal.timeout(1_000), async (transaction): Promise<void> => {
        await transaction.query(
          'UPDATE example SET value = $1',
          ['new'],
          AbortSignal.timeout(1_000)
        )
      }),
      /failed UPDATE/u
    )
    assert.deepEqual(pool.connection.statements, [
      'BEGIN',
      'UPDATE example SET value = $1',
      'ROLLBACK',
    ])
    assert.equal(pool.connection.releaseCalls, 2)
  })
})
