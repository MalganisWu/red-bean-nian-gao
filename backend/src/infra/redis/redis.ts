import { createClient } from 'redis'
import { normalizeError } from '../../shared/errors/normalize-error.js'

/*
 * 下面这些 Lua 脚本存在的唯一理由是**原子性**。
 * Redis 的单条命令是原子的，但「先读再写」不是：如果拆成两次往返，
 * 中间可能被别的客户端插进来（锁在被 GET 与 PEXPIRE 之间过期并被别人抢走、
 * 队列元素在 LPOP 与 RPUSH 之间丢失）。放进一个 EVAL 就在服务端串成了一次执行。
 *
 * 脚本约定：返回 `1` / 正整数表示「做成了」，返回 `0` 表示「前置条件不满足，什么都没做」。
 * 调用方据此区分「成功」与「安静地没做事」——后者不是错误，是并发下的正常结果。
 */

/** 值仍是期望值时才续期，避免给一个已被他人接管的锁续命。 */
const COMPARE_AND_EXPIRE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

/**
 * 值仍是期望值时才删除。释放锁必须用它而不是裸 `DEL`：
 * 如果自己的锁已经超时并被别人重新获取，裸 DEL 会把**别人的**锁删掉。
 */
const COMPARE_AND_DELETE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const LIST_RIGHT_PUSH_SCRIPT = 'return redis.call("rpush", KEYS[1], ARGV[1])'
const LIST_RANGE_SCRIPT = 'return redis.call("lrange", KEYS[1], 0, -1)'
/**
 * 从待办队列取出一个元素并**同时**放进处理中队列（KEYS[2]）。
 * 两步必须原子：只 LPOP 的话，消费者在写完结果前崩溃，这条消息就永久消失了。
 * 放进 processing 列表后，它至少还能被 `LIST_RECOVER` 捞回来重投。
 */
const LIST_CLAIM_SCRIPT = `
local item = redis.call("lpop", KEYS[1])
if item then redis.call("rpush", KEYS[2], item) end
return item
`
/** 处理失败时把元素从 processing 放回队首（LPUSH），让它先于其他消息被重试。 */
const LIST_REQUEUE_SCRIPT = `
local removed = redis.call("lrem", KEYS[2], 1, ARGV[1])
if removed > 0 then redis.call("lpush", KEYS[1], ARGV[1]) end
return removed
`
/**
 * 把 processing 列表整体倒回待办队列，用于进程启动时回收上次崩溃遗留的在途消息。
 * 从队尾（RPOP）搬回队首（LPUSH），顺序因此保持与原来一致。
 */
const LIST_RECOVER_SCRIPT = `
while redis.call("llen", KEYS[2]) > 0 do
  redis.call("rpoplpush", KEYS[2], KEYS[1])
end
return 0
`
const LIST_REMOVE_SCRIPT = 'return redis.call("lrem", KEYS[1], 1, ARGV[1])'
/** 追加并续期必须原子，否则可能先追加成功、续期前进程挂掉，留下一个永不过期的列表。 */
const LIST_APPEND_WITH_EXPIRY_SCRIPT = `
redis.call("rpush", KEYS[1], ARGV[1])
redis.call("expire", KEYS[1], ARGV[2])
return 1
`
/**
 * 带守卫的追加：只有 KEYS[1] 的值仍是 ARGV[1] 时才写进 KEYS[2]。
 * 守卫键代表「当前持有者/会话代次」，值变了说明持有者已经换人，
 * 此时往旧列表追加就会把消息投给一个已经不存在或已被接管的消费者。
 */
const GUARDED_LIST_APPEND_WITH_EXPIRY_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("rpush", KEYS[2], ARGV[2])
redis.call("expire", KEYS[2], ARGV[3])
return 1
`
/** 带守卫的删除；与上面同源，用于「只有我仍是持有者时才清理这份数据」。 */
const GUARDED_DELETE_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("del", KEYS[2])
return 1
`
/** 一次性读完并清空：读与删之间不能有别的写入者，否则会漏掉消息或重复消费。 */
const LIST_CONSUME_SCRIPT = `
local data = redis.call("lrange", KEYS[1], 0, -1)
redis.call("del", KEYS[1])
return data
`

export interface RedisStore {
  set(key: string, value: string, ttlMilliseconds: number, signal: AbortSignal): Promise<void>
  setIfAbsent(
    key: string,
    value: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean>
  get(key: string, signal: AbortSignal): Promise<string | undefined>
  delete(key: string, signal: AbortSignal): Promise<void>
  compareAndExpire(
    key: string,
    expectedValue: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean>
  compareAndDelete(key: string, expectedValue: string, signal: AbortSignal): Promise<boolean>
  ttlMilliseconds(key: string, signal: AbortSignal): Promise<number>
}

export interface RedisDriver {
  connect(): Promise<void>
  ping(): Promise<string>
  quit(): Promise<string>
  destroy(): void
  set(
    key: string,
    value: string,
    options: { readonly PX: number; readonly NX?: true }
  ): Promise<string | null>
  get(key: string): Promise<string | null>
  del(key: string): Promise<number>
  pTTL(key: string): Promise<number>
  eval(
    script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }
  ): Promise<unknown>
}

export interface RedisDriverFactory {
  create(url: string): RedisDriver
}

class NodeRedisDriver implements RedisDriver {
  readonly #client: ReturnType<typeof createClient>

  public constructor(url: string) {
    this.#client = createClient({ url })
  }

  public async connect(): Promise<void> {
    await this.#client.connect()
  }

  public ping(): Promise<string> {
    return this.#client.ping()
  }

  public quit(): Promise<string> {
    return this.#client.quit()
  }

  public destroy(): void {
    this.#client.destroy()
  }

  public set(
    key: string,
    value: string,
    options: { readonly PX: number; readonly NX?: true }
  ): Promise<string | null> {
    return this.#client.set(key, value, options)
  }

  public get(key: string): Promise<string | null> {
    return this.#client.get(key)
  }

  public del(key: string): Promise<number> {
    return this.#client.del(key)
  }

  public pTTL(key: string): Promise<number> {
    return this.#client.pTTL(key)
  }

  public eval(
    script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }
  ): Promise<unknown> {
    return this.#client.eval(script, { keys: [...options.keys], arguments: [...options.arguments] })
  }
}

class DefaultRedisDriverFactory implements RedisDriverFactory {
  public create(url: string): RedisDriver {
    return new NodeRedisDriver(url)
  }
}

/**
 * Redis 边界的统一入口，分两类能力：
 * - **KV 与比较交换**（`set` / `get` / `compareAndExpire` / `compareAndDelete`）：主要供分布式锁使用，
 *   「比较」的是值而不是键是否存在。
 * - **列表队列**（`list*`）：投递队列与恢复缓冲。`Claim → Requeue/Consume` 构成一次投递的生命周期，
 *   `Recover` 供启动时回收在途消息，`Guarded*` 系列用守卫键防止把消息投给已经换人的消费者。
 *
 * 取消语义与 Postgres 边界一致：Redis 命令发出后无法撤回，
 * 所以每个方法都在**前后各查一次** `signal`——返回时若已中止就丢弃结果并抛错。
 * 副作用（写、删、出队）**已经发生**，这一点调用方必须知道：取消不等于回滚。
 */
export class RedisConnection implements RedisStore {
  readonly #driver: RedisDriver
  #closePromise: Promise<void> | undefined

  public constructor(driver: RedisDriver) {
    this.#driver = driver
  }

  public async set(
    key: string,
    value: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await this.#driver.set(key, value, { PX: ttlMilliseconds })
    signal.throwIfAborted()
  }

  public async setIfAbsent(
    key: string,
    value: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    const result = await this.#driver.set(key, value, { PX: ttlMilliseconds, NX: true })
    signal.throwIfAborted()
    return result === 'OK'
  }

  public async get(key: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted()
    const result = await this.#driver.get(key)
    signal.throwIfAborted()
    return result ?? undefined
  }

  public async delete(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.#driver.del(key)
    signal.throwIfAborted()
  }

  public async compareAndExpire(
    key: string,
    expectedValue: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    const result = await this.#driver.eval(COMPARE_AND_EXPIRE_SCRIPT, {
      keys: [key],
      arguments: [expectedValue, String(ttlMilliseconds)],
    })
    signal.throwIfAborted()
    return redisInteger(result) > 0
  }

  public async compareAndDelete(
    key: string,
    expectedValue: string,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    const result = await this.#driver.eval(COMPARE_AND_DELETE_SCRIPT, {
      keys: [key],
      arguments: [expectedValue],
    })
    signal.throwIfAborted()
    return redisInteger(result) > 0
  }

  public async ttlMilliseconds(key: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    const result = await this.#driver.pTTL(key)
    signal.throwIfAborted()
    return result
  }

  public async ping(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const response = await this.#driver.ping()
    signal.throwIfAborted()
    if (response !== 'PONG') throw new Error(`redis ping returned ${JSON.stringify(response)}`)
  }

  /** 产品投递队列使用的 Redis 原子列表操作。 */
  public async listRightPush(key: string, value: string, signal: AbortSignal): Promise<void> {
    await this.#evaluate(LIST_RIGHT_PUSH_SCRIPT, [key], [value], signal)
  }

  public async listRange(key: string, signal: AbortSignal): Promise<readonly string[]> {
    const result = await this.#evaluate(LIST_RANGE_SCRIPT, [key], [], signal)
    if (!Array.isArray(result)) throw new Error('redis list range returned an invalid value')
    const values: string[] = []
    for (const item of result) {
      if (typeof item !== 'string') throw new Error('redis list range returned an invalid value')
      values.push(item)
    }
    return values
  }

  /**
   * 取出一个待处理元素，同时把它转入 processing 列表。
   * 返回 `undefined` 表示队列为空——这是正常结果，不是错误。
   */
  public async listClaim(
    sourceKey: string,
    processingKey: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const result = await this.#evaluate(LIST_CLAIM_SCRIPT, [sourceKey, processingKey], [], signal)
    if (result === null) return undefined
    if (typeof result !== 'string') throw new Error('redis list claim returned an invalid value')
    return result
  }

  public async listRequeue(
    sourceKey: string,
    processingKey: string,
    entry: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.#evaluate(LIST_REQUEUE_SCRIPT, [sourceKey, processingKey], [entry], signal)
  }

  public async listRecover(
    sourceKey: string,
    processingKey: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.#evaluate(LIST_RECOVER_SCRIPT, [sourceKey, processingKey], [], signal)
  }

  public async listRemove(key: string, entry: string, signal: AbortSignal): Promise<void> {
    await this.#evaluate(LIST_REMOVE_SCRIPT, [key], [entry], signal)
  }

  /** 原子追加恢复消息，并刷新其保留时间。 */
  public async appendListWithExpiry(
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<void> {
    await this.#evaluate(LIST_APPEND_WITH_EXPIRY_SCRIPT, [key], [value, String(ttlSeconds)], signal)
  }

  /**
   * 守卫键仍是期望值时才追加。
   * 返回 `false` 表示守卫已失效（持有者换人），**调用方不应把它当失败重试**——
   * 重试只会再次被拒；正确的反应是放弃这次投递。
   */
  public async appendListWithExpiryIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const result = await this.#evaluate(
      GUARDED_LIST_APPEND_WITH_EXPIRY_SCRIPT,
      [guardKey, key],
      [expectedValue, value, String(ttlSeconds)],
      signal
    )
    return result === 1
  }

  public async deleteIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const result = await this.#evaluate(
      GUARDED_DELETE_SCRIPT,
      [guardKey, key],
      [expectedValue],
      signal
    )
    return result === 1
  }

  /** 原子读取并删除完整的恢复消息列表。 */
  public async consumeList(key: string, signal: AbortSignal): Promise<readonly string[]> {
    const result = await this.#evaluate(LIST_CONSUME_SCRIPT, [key], [], signal)
    return redisStringArray(result, 'redis list consume')
  }

  /** 幂等关闭：反复调用共享同一次 `quit()`，不会重复断开。 */
  public close(): Promise<void> {
    this.#closePromise ??= this.#driver.quit().then((): void => undefined)
    return this.#closePromise
  }

  async #evaluate(
    script: string,
    keys: readonly string[],
    arguments_: readonly string[],
    signal: AbortSignal
  ): Promise<unknown> {
    signal.throwIfAborted()
    const result = await this.#driver.eval(script, { keys, arguments: arguments_ })
    signal.throwIfAborted()
    return result
  }
}

/**
 * 建连并做一次真实往返验证。
 * `connect()` 成功只说明 socket 建立了，不保证这是个能用的 Redis（可能连到了错误的实例或代理），
 * 所以补一次 `ping()`。
 * 失败时用 `destroy()` 而不是 `quit()`：连接此刻已不可用，`quit()` 会尝试优雅关闭并等待回应，
 * 反而可能卡住；`destroy()` 是同步的强制断开。
 */
export async function connectRedis(
  redisUrl: string,
  signal: AbortSignal,
  factory: RedisDriverFactory = new DefaultRedisDriverFactory()
): Promise<RedisConnection> {
  validateRedisUrl(redisUrl)
  signal.throwIfAborted()
  const driver = factory.create(redisUrl)
  try {
    await driver.connect()
    await driver.ping()
    signal.throwIfAborted()
    return new RedisConnection(driver)
  } catch (cause: unknown) {
    driver.destroy()
    throw new Error(`redis 连接失败: ${normalizeError(cause).message}`, { cause })
  }
}

/** 提前拦住明显错误的 URL：空值，以及 `http:` 这类会被 `createClient` 拒掉的协议。 */
function validateRedisUrl(value: string): void {
  if (value.trim() === '') throw new Error('REDIS_URL 未设置')
  let url: URL
  try {
    url = new URL(value)
  } catch (cause: unknown) {
    throw new Error(`redis URL 解析失败: ${normalizeError(cause).message}`, { cause })
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('redis URL 解析失败: protocol must be redis or rediss')
  }
}

/** Lua 的整数返回值可能是 number 或 bigint（取决于客户端与数值大小），两者都接受。 */
function redisInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('invalid Redis integer response')
}

function redisStringArray(value: unknown, operation: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${operation} returned an invalid value`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${operation} returned an invalid value`)
    items.push(item)
  }
  return items
}
