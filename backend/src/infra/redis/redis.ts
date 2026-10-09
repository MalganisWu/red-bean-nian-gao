import { createClient } from 'redis'
import { normalizeError } from '../../shared/errors/normalize-error.js'

const COMPARE_AND_EXPIRE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

const COMPARE_AND_DELETE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const LIST_RIGHT_PUSH_SCRIPT = 'return redis.call("rpush", KEYS[1], ARGV[1])'
const LIST_RANGE_SCRIPT = 'return redis.call("lrange", KEYS[1], 0, -1)'
const LIST_CLAIM_SCRIPT = `
local item = redis.call("lpop", KEYS[1])
if item then redis.call("rpush", KEYS[2], item) end
return item
`
const LIST_REQUEUE_SCRIPT = `
local removed = redis.call("lrem", KEYS[2], 1, ARGV[1])
if removed > 0 then redis.call("lpush", KEYS[1], ARGV[1]) end
return removed
`
const LIST_RECOVER_SCRIPT = `
while redis.call("llen", KEYS[2]) > 0 do
  redis.call("rpoplpush", KEYS[2], KEYS[1])
end
return 0
`
const LIST_REMOVE_SCRIPT = 'return redis.call("lrem", KEYS[1], 1, ARGV[1])'
const LIST_APPEND_WITH_EXPIRY_SCRIPT = `
redis.call("rpush", KEYS[1], ARGV[1])
redis.call("expire", KEYS[1], ARGV[2])
return 1
`
const GUARDED_LIST_APPEND_WITH_EXPIRY_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("rpush", KEYS[2], ARGV[2])
redis.call("expire", KEYS[2], ARGV[3])
return 1
`
const GUARDED_DELETE_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("del", KEYS[2])
return 1
`
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
