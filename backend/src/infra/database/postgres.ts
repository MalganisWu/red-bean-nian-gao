import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { normalizeError } from '../../shared/errors/normalize-error.js'

/**
 * 连接池默认值。
 * `maxLifetime` 设为 30 分钟是为了让长连接定期重建——云上数据库的故障转移、
 * 证书轮换和连接级内存问题都靠它自愈，而不是等到某个请求超时才发现。
 * 保留 5 条常驻连接，避免低频环境下每次请求都要重新握手。
 */
const DEFAULT_MAX_CONNECTIONS = 20
/** 常驻连接下限；低频环境下保留这几条，避免每次请求都重新握手。 */
const DEFAULT_MIN_CONNECTIONS = 5
/** 连接最长存活秒数（30 分钟）；到点重建，让故障转移、证书轮换与连接级内存问题自愈。 */
const DEFAULT_MAX_LIFETIME_SECONDS = 30 * 60
/** 空闲连接回收毫秒数（5 分钟）；回收长期不用的连接，避免池里越堆越多。 */
const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000

/** 查询结果的最小投影：`rowCount` 已把 pg 返回的 `null` 归一成 0。 */
export interface SqlQueryResult {
  /** 返回的数据行；非查询语句通常为空数组。 */
  readonly rows: readonly unknown[]
  /** 受影响行数；pg 返回的 `null` 已归一成 0，调用方可直接做数值比较。 */
  readonly rowCount: number
}

/** 查询入口；Repository 只依赖这一层，不感知连接、池与事务。 */
export interface SqlExecutor {
  /**
   * 执行一条 SQL，不做隐式事务包装。
   * @param sql - SQL 文本，占位符用 `$1` / `$2`
   * @param parameters - 与占位符一一对应的参数值
   * @param signal - 取消信号，查询前后各检查一次
   * @returns 查询结果
   */
  query(sql: string, parameters: readonly unknown[], signal: AbortSignal): Promise<SqlQueryResult>
}

/** 在 `SqlExecutor` 之上增加事务能力；`transaction` 内的查询共用同一条连接与同一个事务。 */
export interface TransactionalSqlExecutor extends SqlExecutor {
  /**
   * 在一个连接上跑一段事务；事务体内的查询共用同一条连接与同一个事务。
   * @param signal - 取消信号
   * @param operation - 事务体，只能通过其收到的 `transaction` 执行查询
   * @returns 事务体返回的值，仅在提交成功后交给调用方
   */
  transaction<TValue>(
    signal: AbortSignal,
    operation: (transaction: SqlExecutor) => Promise<TValue>
  ): Promise<TValue>
}

/** 单条连接的驱动抽象；`release()` 必须被调用，否则连接不会还给池子。 */
export interface SqlConnectionDriver {
  /**
   * 在这条连接上执行一条 SQL。
   * @param sql - SQL 文本
   * @param parameters - 参数值，缺省为空数组
   * @returns 查询结果
   */
  query(sql: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>
  /** 把连接还给池子；每条 `connect()` 出来的连接都必须调用一次。 */
  release(): void
}

/** 连接池驱动抽象；抽出来是为了让测试注入假实现，不必依赖真实 pg。 */
export interface PostgresPoolDriver {
  /**
   * 直接从池上执行一条 SQL；不保证绑定同一条连接。
   * @param sql - SQL 文本
   * @param parameters - 参数值，缺省为空数组
   * @returns 查询结果
   */
  query(sql: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>
  /**
   * 独占一条连接；用完必须 `release()`，否则连接不会还给池子。
   * @returns 单条连接的驱动
   */
  connect(): Promise<SqlConnectionDriver>
  /** 关闭池子；关闭后不能再查询或取连接。 */
  end(): Promise<void>
}

/** 建池参数；默认值见文件顶部那组常量，这里全是必填以杜绝「漏传即静默用默认」。 */
export interface PostgresPoolOptions {
  /** PG 连接串；空值会在建池前被拒，不做默认值兜底。 */
  readonly connectionString: string
  /** 池内连接数上限，超出后新查询排队等待。 */
  readonly maxConnections: number
  /** 池内常驻连接数下限。 */
  readonly minConnections: number
  /** 单条连接最长存活秒数，到点重建连接。 */
  readonly maxLifetimeSeconds: number
  /** 空闲连接被回收前的毫秒数。 */
  readonly idleTimeoutMilliseconds: number
}

/** 造池的工厂；默认实现直接 new 出 `pg.Pool`，测试可替换成内存实现。 */
export interface PostgresPoolDriverFactory {
  /**
   * 按给定参数造一个池驱动。
   * @param options - 已填好默认值的建池参数
   * @returns 池驱动的实现
   */
  create(options: PostgresPoolOptions): PostgresPoolDriver
}

/** `pg` 单条连接的薄包装：把行数与 `null` 归一，其余原样透传。 */
class PgConnectionDriver implements SqlConnectionDriver {
  /** pg 的原始连接对象；`release()` 直接转交给它。 */
  readonly #client: PoolClient

  public constructor(client: PoolClient) {
    this.#client = client
  }

  /**
   * 在这条连接上执行一条 SQL。
   * @param sql - SQL 文本
   * @param parameters - 参数值，缺省为空数组
   * @returns 查询结果，`rowCount` 已把 `null` 归一成 0
   */
  public async query(sql: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
    const result = await this.#client.query<Record<string, unknown>, unknown[]>(sql, [
      ...parameters,
    ])
    return { rows: result.rows, rowCount: result.rowCount ?? 0 }
  }

  /** 把连接还给池子；必须调用，否则连接不会释放。 */
  public release(): void {
    this.#client.release()
  }
}

/** 基于 `pg.Pool` 的池驱动；只负责把参数翻译成 `PoolConfig` 并转发调用。 */
class PgPoolDriver implements PostgresPoolDriver {
  /** 底层 `pg.Pool`；`end()` 即调用它的 `end()`。 */
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

  /**
   * 直接从池上执行一条 SQL；不保证绑定同一条连接。
   * @param sql - SQL 文本
   * @param parameters - 参数值，缺省为空数组
   * @returns 查询结果，`rowCount` 已把 `null` 归一成 0
   */
  public async query(sql: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
    const result = await this.#pool.query<Record<string, unknown>, unknown[]>(sql, [...parameters])
    return { rows: result.rows, rowCount: result.rowCount ?? 0 }
  }

  /**
   * 从池里独占一条连接。
   * @returns 包装后的单条连接驱动，调用方负责 `release()`
   */
  public async connect(): Promise<SqlConnectionDriver> {
    return new PgConnectionDriver(await this.#pool.connect())
  }

  /** 关闭池子；关闭后无法再查询或取连接。 */
  public end(): Promise<void> {
    return this.#pool.end()
  }
}

/** 生产用的默认工厂：直接造 `PgPoolDriver`；测试可替换成内存实现。 */
class DefaultPostgresPoolDriverFactory implements PostgresPoolDriverFactory {
  /**
   * 造一个真实的 pg 池驱动。
   * @param options - 建池参数
   * @returns 基于 `pg.Pool` 的池驱动
   */
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
  /** 池驱动；由构造函数注入，便于测试替换成内存实现。 */
  readonly #pool: PostgresPoolDriver
  /** 首次 `close()` 时缓存的关闭 Promise，用来实现幂等关闭。 */
  #closePromise: Promise<void> | undefined

  public constructor(pool: PostgresPoolDriver) {
    this.#pool = pool
  }

  /**
   * 在池上执行一条 SQL，不做任何隐式事务包装。
   * 本层**不做 SQL 注入校验或参数转义**：`sql` 是调用方给定的语句文本，占位符使用
   * `$1` 形式并靠 `parameters` 传值；把外部输入拼进 SQL 文本是调用方的责任。
   * 取消只在前后检查 `signal`，因此查询失败（语法、约束、连接中断）时异常原样向上抛，
   * 不加包装，由调用方决定重试还是上抛。
   * @param sql - SQL 文本，占位符用 `$1` / `$2`
   * @param parameters - 与占位符一一对应的参数值，避免把外部输入拼进 SQL 文本
   * @param signal - 取消信号，查询前后各检查一次，已中止则抛错
   * @returns 查询结果；`rowCount` 已把 pg 的 `null` 归一成 0
   */
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
   * @param signal - 取消信号；操作返回后到 `COMMIT` 之前再查一次，已中止则走回滚而非提交
   * @param operation - 事务体；只能通过收到的 `transaction` 执行查询，否则会跑到事务之外
   * @returns 事务体返回的值，仅在 `COMMIT` 成功后才会交给调用方
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

/** 事务内部的执行器；固定绑定事务所用那一条连接，保证语句不会跑到事务之外。 */
class TransactionExecutor implements SqlExecutor {
  /** 事务独占的连接；查询、提交与回滚都用它。 */
  readonly #connection: SqlConnectionDriver

  public constructor(connection: SqlConnectionDriver) {
    this.#connection = connection
  }

  /**
   * 在这条事务连接上执行一条 SQL。
   * @param sql - SQL 文本
   * @param parameters - 参数值
   * @param signal - 取消信号，查询前后各检查一次
   * @returns 查询结果
   */
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
 * @param databaseUrl - 连接串；空值直接抛错，不尝试用默认值兜底
 * @param signal - 启动期取消信号，建池前与探测后各检查一次
 * @param factory - 造池工厂，测试可注入内存实现以避开真实数据库
 * @returns 已完成 `SELECT 1` 探测的数据库对象；任何一步失败都抛错且不返回半初始化对象
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
