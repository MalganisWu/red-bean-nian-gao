import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { normalizeError } from '../../shared/errors/normalize-error.js'

/**
 * 连接池默认值。
 * `maxLifetime` 设为 30 分钟是为了让长连接定期重建——云上数据库的故障转移、
 * 证书轮换和连接级内存问题都靠它自愈，而不是等到某个请求超时才发现。
 * 保留 5 条常驻连接，避免低频环境下每次请求都要重新握手。
 */
const DEFAULT_MAX_CONNECTIONS = 20
const DEFAULT_MIN_CONNECTIONS = 5
const DEFAULT_MAX_LIFETIME_SECONDS = 30 * 60
const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000

/** 查询结果的最小投影：`rowCount` 已把 pg 返回的 `null` 归一成 0。 */
export interface SqlQueryResult {
  readonly rows: readonly unknown[]
  readonly rowCount: number
}

/** 查询入口；Repository 只依赖这一层，不感知连接、池与事务。 */
export interface SqlExecutor {
  query(sql: string, parameters: readonly unknown[], signal: AbortSignal): Promise<SqlQueryResult>
}

/** 在 `SqlExecutor` 之上增加事务能力；`transaction` 内的查询共用同一条连接与同一个事务。 */
export interface TransactionalSqlExecutor extends SqlExecutor {
  transaction<TValue>(
    signal: AbortSignal,
    operation: (transaction: SqlExecutor) => Promise<TValue>
  ): Promise<TValue>
}

/** 单条连接的驱动抽象；`release()` 必须被调用，否则连接不会还给池子。 */
export interface SqlConnectionDriver {
  query(sql: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>
  release(): void
}

/** 连接池驱动抽象；抽出来是为了让测试注入假实现，不必依赖真实 pg。 */
export interface PostgresPoolDriver {
  query(sql: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>
  connect(): Promise<SqlConnectionDriver>
  end(): Promise<void>
}

/** 建池参数；默认值见文件顶部那组常量，这里全是必填以杜绝「漏传即静默用默认」。 */
export interface PostgresPoolOptions {
  readonly connectionString: string
  readonly maxConnections: number
  readonly minConnections: number
  readonly maxLifetimeSeconds: number
  readonly idleTimeoutMilliseconds: number
}

/** 造池的工厂；默认实现直接 new 出 `pg.Pool`，测试可替换成内存实现。 */
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

/**
 * Repository 与 migration runner 共用的轻量 pg 边界。
 *
 * 取消语义值得单独说明：`pg` 的查询**不感知 AbortSignal**，无法中途掐断一条已在执行的 SQL。
 * 所以这里用的是「查询前后各查一次」的办法：查询返回后若发现信号已中止，就丢弃结果并抛错。
 * 效果是调用方不会基于一个自己已经放弃的请求去继续写数据，代价是那条 SQL 仍会跑完
 * （服务端可能仍有副作用）——需要真正中断的场景得用 `pg_cancel_backend` 之类的手段，
 * 不在这一层的职责内。
 */
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

  /**
   * 在一个连接上跑一段事务。
   *
   * `COMMIT` 之前再查一次 `signal`：这是**取消能不能真正生效的分水岭**——
   * 如果操作跑到一半调用方取消了，这里会走进 catch 分支执行 ROLLBACK，
   * 而不是把一个已被放弃的写入提交上去。
   *
   * 回滚本身失败时，把「原始错误 + 回滚错误」聚合成 `AggregateError` 抛出，
   * 而不是让回滚错误顶掉原始错误：排障时前者才是根因。
   * `release()` 放在 finally，保证无论提交、回滚还是回滚失败，连接都会还给池子。
   */
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

  /** 幂等关闭：并发或重复调用共享同一个 end()，不会重复销毁池子。 */
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

/**
 * 创建并验证带容量上限的 PostgreSQL 连接池。
 *
 * 建池只说明参数合法，不代表连得上，所以这里用 `SELECT 1` 做一次真实往返。
 * 探测失败时必须把已经建好的池关掉——`pg` 的 Pool 会持有后台定时器与 socket，
 * 不关就是一个进程无法退出的泄漏。若连关闭也失败，两个错误一起抛，别让清理失败掩盖根因。
 */
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
