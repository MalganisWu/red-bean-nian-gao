import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { normalizeError } from '../../shared/errors/normalize-error.js'

const DEFAULT_MAX_CONNECTIONS = 20
const DEFAULT_MIN_CONNECTIONS = 5
const DEFAULT_MAX_LIFETIME_SECONDS = 30 * 60
const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000

export interface SqlQueryResult {
  readonly rows: readonly unknown[]
  readonly rowCount: number
}

export interface SqlExecutor {
  query(sql: string, parameters: readonly unknown[], signal: AbortSignal): Promise<SqlQueryResult>
}

export interface TransactionalSqlExecutor extends SqlExecutor {
  transaction<TValue>(
    signal: AbortSignal,
    operation: (transaction: SqlExecutor) => Promise<TValue>
  ): Promise<TValue>
}

export interface SqlConnectionDriver {
  query(sql: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>
  release(): void
}

export interface PostgresPoolDriver {
  query(sql: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>
  connect(): Promise<SqlConnectionDriver>
  end(): Promise<void>
}

export interface PostgresPoolOptions {
  readonly connectionString: string
  readonly maxConnections: number
  readonly minConnections: number
  readonly maxLifetimeSeconds: number
  readonly idleTimeoutMilliseconds: number
}

export interface PostgresPoolDriverFactory {
  create(options: PostgresPoolOptions): PostgresPoolDriver
}

class PgConnectionDriver implements SqlConnectionDriver {
  readonly #client: PoolClient

  public constructor(client: PoolClient) {
    this.#client = client
  }

  public async query(sql: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
    const result = await this.#client.query<Record<string, unknown>, unknown[]>(sql, [
      ...parameters,
    ])
    return { rows: result.rows, rowCount: result.rowCount ?? 0 }
  }

  public release(): void {
    this.#client.release()
  }
}

class PgPoolDriver implements PostgresPoolDriver {
  readonly #pool: Pool

  public constructor(options: PostgresPoolOptions) {
    const config: PoolConfig = {
      connectionString: options.connectionString,
      max: options.maxConnections,
      min: options.minConnections,
      maxLifetimeSeconds: options.maxLifetimeSeconds,
      idleTimeoutMillis: options.idleTimeoutMilliseconds,
    }
    this.#pool = new Pool(config)
  }

  public async query(sql: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
    const result = await this.#pool.query<Record<string, unknown>, unknown[]>(sql, [...parameters])
    return { rows: result.rows, rowCount: result.rowCount ?? 0 }
  }

  public async connect(): Promise<SqlConnectionDriver> {
    return new PgConnectionDriver(await this.#pool.connect())
  }

  public end(): Promise<void> {
    return this.#pool.end()
  }
}

class DefaultPostgresPoolDriverFactory implements PostgresPoolDriverFactory {
  public create(options: PostgresPoolOptions): PostgresPoolDriver {
    return new PgPoolDriver(options)
  }
}

/** Repository 与 migration runner 共用的轻量 pg 边界。 */
export class PostgresDatabase implements TransactionalSqlExecutor {
  readonly #pool: PostgresPoolDriver
  #closePromise: Promise<void> | undefined

  public constructor(pool: PostgresPoolDriver) {
    this.#pool = pool
  }

  public async query(
    sql: string,
    parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    const result = await this.#pool.query(sql, parameters)
    signal.throwIfAborted()
    return result
  }

  public async transaction<TValue>(
    signal: AbortSignal,
    operation: (transaction: SqlExecutor) => Promise<TValue>
  ): Promise<TValue> {
    signal.throwIfAborted()
    const connection = await this.#pool.connect()
    const transaction = new TransactionExecutor(connection)
    try {
      await connection.query('BEGIN')
      const value = await operation(transaction)
      signal.throwIfAborted()
      await connection.query('COMMIT')
      return value
    } catch (cause: unknown) {
      try {
        await connection.query('ROLLBACK')
      } catch (rollbackCause: unknown) {
        throw new AggregateError(
          [normalizeError(cause), normalizeError(rollbackCause)],
          'rollback PostgreSQL transaction',
          { cause: rollbackCause }
        )
      }
      throw cause
    } finally {
      connection.release()
    }
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#pool.end()
    return this.#closePromise
  }
}

class TransactionExecutor implements SqlExecutor {
  readonly #connection: SqlConnectionDriver

  public constructor(connection: SqlConnectionDriver) {
    this.#connection = connection
  }

  public async query(
    sql: string,
    parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    const result = await this.#connection.query(sql, parameters)
    signal.throwIfAborted()
    return result
  }
}

/** 创建并验证带容量上限的 PostgreSQL 连接池。 */
export async function connectPostgres(
  databaseUrl: string,
  signal: AbortSignal,
  factory: PostgresPoolDriverFactory = new DefaultPostgresPoolDriverFactory()
): Promise<PostgresDatabase> {
  if (databaseUrl.trim() === '') throw new Error('DATABASE_URL 未设置')
  signal.throwIfAborted()
  const pool = factory.create({
    connectionString: databaseUrl,
    maxConnections: DEFAULT_MAX_CONNECTIONS,
    minConnections: DEFAULT_MIN_CONNECTIONS,
    maxLifetimeSeconds: DEFAULT_MAX_LIFETIME_SECONDS,
    idleTimeoutMilliseconds: DEFAULT_IDLE_TIMEOUT_MILLISECONDS,
  })
  const database = new PostgresDatabase(pool)
  try {
    await database.query('SELECT 1', [], signal)
    return database
  } catch (cause: unknown) {
    try {
      await database.close()
    } catch (closeCause: unknown) {
      throw new AggregateError(
        [normalizeError(cause), normalizeError(closeCause)],
        `数据库连接失败: ${normalizeError(cause).message}`,
        { cause: closeCause }
      )
    }
    throw new Error(`数据库连接失败: ${normalizeError(cause).message}`, { cause })
  }
}
