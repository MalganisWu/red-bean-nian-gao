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

/** 单条 `RPUSH`，本身即原子；包成脚本只为与其它列表操作共用同一条下发路径与返回值约定。 */
const LIST_RIGHT_PUSH_SCRIPT = 'return redis.call("rpush", KEYS[1], ARGV[1])'
/**
 * 读列表全量元素的快照脚本（`LRANGE 0 -1`），返回值是元素数组而非计数。
 * 它不带任何写操作，因此不存在「拆成两次往返会读到中间态」的问题；
 * 但列表大时会一次性全部取回，只适合规模可控的恢复消息列表。
 */
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
/**
 * `LREM` 删除第一个匹配元素。`count` 固定为 `1` 而不是 `0`：同一条消息可能因重投、
 * 重复回收而出现多份，只删本次消费的那一份，避免误伤还在被别的消费者处理的副本。
 * 元素不在列表中时返回 `0`，这是幂等清理的正常结果，不是错误。
 */
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

/** KV 与比较交换接口；比较的是**值**而不是键是否存在，这正是「不会误删别人的锁」的关键。 */
export interface RedisStore {
  /**
   * 无条件写入键并设置毫秒级 TTL，不看旧值；需要互斥语义时应改用 `setIfAbsent`。
   * @param key - 目标键；本接口不加命名空间前缀，键的唯一性由调用方负责
   * @param value - 待写入的字符串，序列化由调用方完成
   * @param ttlMilliseconds - 存活时间（毫秒）
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  set(key: string, value: string, ttlMilliseconds: number, signal: AbortSignal): Promise<void>
  /**
   * 仅当键不存在时写入，是获取分布式锁的原语（Redis 的 `SET NX`）。
   * @param key - 锁键
   * @param value - 持有者标识；后续比较交换靠它确认所有权
   * @param ttlMilliseconds - 锁的存活时间（毫秒）
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否写入成功；`false` 表示键已被他人占用，本次未做任何修改，属于正常竞争结果
   */
  setIfAbsent(
    key: string,
    value: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean>
  /**
   * 读取键的当前值；键不存在返回 `undefined` 而不是空串，以便与「值恰好是空字符串」区分。
   * @param key - 目标键
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 键的值；键不存在时为 `undefined`
   */
  get(key: string, signal: AbortSignal): Promise<string | undefined>
  /**
   * 无条件删除键，只应在确认数据确实归自己所有时使用；释放锁必须改用 `compareAndDelete`。
   * @param key - 目标键
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  delete(key: string, signal: AbortSignal): Promise<void>
  /**
   * 值仍是期望值时才续期（比较与续期在同一段 Lua 内完成，不会被「续期途中被抢锁」插空）。
   * @param key - 锁键
   * @param expectedValue - 期望的当前值，即自己的持有者标识
   * @param ttlMilliseconds - 续期后的存活时间（毫秒）
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否续期成功；`false` 表示值已不匹配，此时续期已无意义，本次未做任何修改
   */
  compareAndExpire(
    key: string,
    expectedValue: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean>
  /**
   * 值仍是期望值时才删除，是释放锁的唯一安全方式；比较与删除在同一段 Lua 内完成。
   * @param key - 锁键
   * @param expectedValue - 期望的当前值，即自己的持有者标识
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否真的删除；`false` 表示锁已不属于自己，什么都不做即正确结果
   */
  compareAndDelete(key: string, expectedValue: string, signal: AbortSignal): Promise<boolean>
  /**
   * 查询键的剩余存活时间（毫秒），语义透传 Redis 的 `PTTL`。
   * @param key - 目标键
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 剩余毫秒数；`-1` 表示键存在但永不过期，`-2` 表示键不存在，两者必须分开判断
   */
  ttlMilliseconds(key: string, signal: AbortSignal): Promise<number>
}

/** 底层客户端的窄接口；上层因此不绑定具体 redis 客户端，测试可注入假驱动。 */
export interface RedisDriver {
  /** 建立连接；未完成前其余命令都不应下发。 */
  connect(): Promise<void>
  /**
   * 发一次 `PING` 并原样返回响应文本，健康判定交由上层决定。
   * @returns 服务端返回的响应文本，正常为 `PONG`
   */
  ping(): Promise<string>
  /**
   * 优雅关闭连接并等待服务端回应。
   * @returns 服务端返回的关闭响应文本
   */
  quit(): Promise<string>
  /** 同步强制断开，不做优雅关闭，用于连接已经不可用的失败路径。 */
  destroy(): void
  /**
   * 透传 Redis 的 `SET`，过期与互斥语义完全由 `options` 决定。
   * @param key - 目标键
   * @param value - 待写入的字符串
   * @param options - `PX` 是必填的过期毫秒数；`NX` 为真时仅在键不存在时写入
   * @returns 写入成功为 `OK`；`NX` 未命中时为 `null`
   */
  set(
    key: string,
    value: string,
    options: { readonly PX: number; readonly NX?: true }
  ): Promise<string | null>
  /**
   * 读取键值。
   * @param key - 目标键
   * @returns 键的值；键不存在时为 `null`
   */
  get(key: string): Promise<string | null>
  /**
   * 无条件删除键。
   * @param key - 目标键
   * @returns 实际删除的键数量
   */
  del(key: string): Promise<number>
  /**
   * 查询键的剩余存活时间（毫秒）。
   * @param key - 目标键
   * @returns 剩余毫秒数；`-1` 为无过期时间，`-2` 为键不存在
   */
  pTTL(key: string): Promise<number>
  /**
   * 执行一段 Lua 脚本；`keys` 与 `arguments` 分列传入，不把参数拼进脚本文本。
   * @param script - Lua 脚本原文
   * @param options - `keys` 作为 `KEYS` 数组、`arguments` 作为 `ARGV` 数组传给脚本
   * @returns 脚本的原始返回值，其类型由脚本自身决定
   */
  eval(
    script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }
  ): Promise<unknown>
}

/** 造驱动的工厂；默认实现基于 node-redis 的 `createClient`。 */
export interface RedisDriverFactory {
  /**
   * 造一个尚未建连的驱动实例；建连由 `RedisDriver.connect` 负责，工厂本身不产生网络副作用。
   * @param url - 连接串，协议必须是 `redis:` 或 `rediss:`
   * @returns 新的驱动实例
   */
  create(url: string): RedisDriver
}

/** 基于 node-redis `createClient` 的默认驱动：把窄接口一对一映射到客户端方法，不做任何策略。 */
class NodeRedisDriver implements RedisDriver {
  /** node-redis 的客户端实例；只在本类内部使用，上层一律通过窄接口访问。 */
  readonly #client: ReturnType<typeof createClient>

  public constructor(url: string) {
    this.#client = createClient({ url })
  }

  /** 建立连接。 */
  public async connect(): Promise<void> {
    await this.#client.connect()
  }

  /**
   * 探活。
   * @returns 服务端返回的响应文本
   */
  public ping(): Promise<string> {
    return this.#client.ping()
  }

  /**
   * 优雅关闭。
   * @returns 服务端返回的关闭响应文本
   */
  public quit(): Promise<string> {
    return this.#client.quit()
  }

  /** 同步强制断开。 */
  public destroy(): void {
    this.#client.destroy()
  }

  /**
   * 透传 `SET`。
   * @param key - 目标键
   * @param value - 待写入的字符串
   * @param options - `PX` 为过期毫秒数；`NX` 为真时仅在键不存在时写入
   * @returns 写入成功为 `OK`；`NX` 未命中时为 `null`
   */
  public set(
    key: string,
    value: string,
    options: { readonly PX: number; readonly NX?: true }
  ): Promise<string | null> {
    return this.#client.set(key, value, options)
  }

  /**
   * 读取键值。
   * @param key - 目标键
   * @returns 键的值；键不存在时为 `null`
   */
  public get(key: string): Promise<string | null> {
    return this.#client.get(key)
  }

  /**
   * 无条件删除键。
   * @param key - 目标键
   * @returns 实际删除的键数量
   */
  public del(key: string): Promise<number> {
    return this.#client.del(key)
  }

  /**
   * 查询剩余存活时间（毫秒）。
   * @param key - 目标键
   * @returns 剩余毫秒数；`-1` 为无过期时间，`-2` 为键不存在
   */
  public pTTL(key: string): Promise<number> {
    return this.#client.pTTL(key)
  }

  /**
   * 执行 Lua 脚本。这里把只读的 `keys` / `arguments` 复制成可变数组，
   * 因为 node-redis 的 `eval` 签名要求可变数组，直接传只读引用无法通过类型检查。
   * @param script - Lua 脚本原文
   * @param options - `keys` 作为 `KEYS` 数组、`arguments` 作为 `ARGV` 数组传给脚本
   * @returns 脚本的原始返回值，其类型由脚本自身决定
   */
  public eval(
    script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }
  ): Promise<unknown> {
    return this.#client.eval(script, { keys: [...options.keys], arguments: [...options.arguments] })
  }
}

/** 默认工厂：每次调用都造一个独立的 node-redis 驱动，实例之间不共享连接。 */
class DefaultRedisDriverFactory implements RedisDriverFactory {
  /**
   * 造一个基于 node-redis 的驱动实例。
   * @param url - 连接串，直接交给 `createClient`
   * @returns 尚未建连的驱动实例
   */
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
  /** 底层驱动；所有 Redis 命令都经它转发。 */
  readonly #driver: RedisDriver
  /** 关闭的共享 Promise；`??=` 保证 `close()` 被反复调用时只断开一次。 */
  #closePromise: Promise<void> | undefined

  public constructor(driver: RedisDriver) {
    this.#driver = driver
  }

  /**
   * 无条件写入键并设置毫秒级 TTL，已有值会被直接覆盖。
   * 它不做「键是否已存在」的判断，需要互斥语义时应改用 `setIfAbsent`。
   * 命令一旦发出就无法撤回：`signal` 只在调用前后检查，中止时抛错但写入可能已经生效。
   * @param key - 目标键；本类不加命名空间前缀，键的唯一性由调用方负责
   * @param value - 待写入的字符串，序列化由调用方完成
   * @param ttlMilliseconds - 存活时间（毫秒）；传 0 或负数会被 Redis 拒绝
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
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

  /**
   * 仅当键不存在时写入，是获取分布式锁的原语（Redis 的 `SET NX`）。
   * 返回 `false` 表示键已被他人占用——这是正常竞争结果而非错误，调用方不应把它当作
   * 需要重试到成功的失败；TTL 与写入在同一条命令内生效，因此不会留下无过期的锁。
   * @param key - 锁键
   * @param value - 持有者标识；后续 `compareAndExpire` / `compareAndDelete` 靠它确认所有权
   * @param ttlMilliseconds - 锁的存活时间（毫秒），必须为正数以免锁永久残留
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否成功写入；`false` 表示键已存在，本次未做任何修改
   */
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

  /**
   * 读取键的当前值。
   * 键不存在返回 `undefined` 而不是空串，让调用方能区分「键已消失（锁被抢占或过期）」
   * 与「值恰好是空字符串」这两种语义完全不同的情况。
   * @param key - 目标键
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 键的值；键不存在时为 `undefined`
   */
  public async get(key: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted()
    const result = await this.#driver.get(key)
    signal.throwIfAborted()
    return result ?? undefined
  }

  /**
   * 无条件删除键，只应在确认数据确实归自己所有时使用。
   * 释放锁必须改用 `compareAndDelete`：裸删除会连带删掉别人已经重新获取的锁。
   * 删除不存在的键不算失败，Redis 不会报错。
   * @param key - 目标键
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  public async delete(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.#driver.del(key)
    signal.throwIfAborted()
  }

  /**
   * 值仍是期望值时才续期，供持有者在锁尚未过期时给自己续命。
   * 比较与续期在同一段 Lua 里完成，因此不会被「续期途中键过期并被他人抢走」插空。
   * 返回 `false` 表示键已被他人接管或已过期，此时续期已经没有意义，
   * 正确反应是停止继续持锁，而不是原地重试。
   * @param key - 锁键
   * @param expectedValue - 期望的当前值，即自己的持有者标识
   * @param ttlMilliseconds - 续期后的存活时间（毫秒）
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否续期成功；`false` 表示值已不匹配且未做任何修改
   */
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

  /**
   * 值仍是期望值时才删除，是释放锁的唯一安全方式。
   * 比较与删除在同一段 Lua 里完成，避免「查到是自己的锁、删之前被别人接管」的竞态。
   * 返回 `false` 表示锁已不属于自己，此时什么都不做就是正确结果，调用方不应报错。
   * @param key - 锁键
   * @param expectedValue - 期望的当前值，即自己的持有者标识
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否真的删除了；`false` 表示值已不匹配且未做任何修改
   */
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

  /**
   * 查询键的剩余存活时间（毫秒），语义直接透传 Redis 的 `PTTL`。
   * `-1` 表示键存在但没有设置过期，`-2` 表示键根本不存在——两者都是负数，
   * 调用方必须分别判断，不能只写 `> 0` 就把「永不过期」和「已消失」当成同一回事。
   * @param key - 目标键
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 剩余毫秒数；无过期时间为 `-1`，键不存在为 `-2`
   */
  public async ttlMilliseconds(key: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    const result = await this.#driver.pTTL(key)
    signal.throwIfAborted()
    return result
  }

  /**
   * 探活：发一次 `PING` 并要求回包是 `PONG`。
   * 这是比「连接对象还在」更可靠的健康判据——TCP 连接可能仍然打开，而对端已经不可用；
   * 响应不是 `PONG` 时直接抛错，不返回布尔值，避免调用方静默忽略不健康状态。
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  public async ping(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const response = await this.#driver.ping()
    signal.throwIfAborted()
    if (response !== 'PONG') throw new Error(`redis ping returned ${JSON.stringify(response)}`)
  }

  /**
   * 产品投递队列使用的 Redis 原子列表操作。
   * @param key - 目标列表键；列表不存在时 `RPUSH` 会自动创建，因此无需先初始化
   * @param value - 入队元素，序列化由调用方负责
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  public async listRightPush(key: string, value: string, signal: AbortSignal): Promise<void> {
    await this.#evaluate(LIST_RIGHT_PUSH_SCRIPT, [key], [value], signal)
  }

  /**
   * 读取列表的全部元素，顺序与入队顺序一致。
   * 这是一次**非原子**快照：列表很大时会一次性取回全部内容到内存，
   * 因此只适合读取规模可控的恢复消息列表，不应用于长队列。
   * @param key - 目标列表键；键不存在时返回空数组而不是报错
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 列表元素数组；键不存在或列表为空时为 `[]`
   */
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
   * 两步在同一段 Lua 里完成，不会出现「元素已出队但尚未登记进 processing」的中间态；
   * 元素一旦进入 `processingKey` 即视为「在途」，其所有权归本次领取者，
   * 只有领取者才能通过 `listRequeue` 归还或由 `listRecover` 在重启时统一回收。
   * @param sourceKey - 待办队列键，从队首（LPOP）取出
   * @param processingKey - 处理中队列键，取出的元素被追加到其队尾；它是崩溃后仍能找回该元素的前提
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 取出的元素；队列为空时为 `undefined`
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

  /**
   * 处理失败时把元素从处理中队列放回待办队首，让它先于其他消息被重试。
   * 只有元素确实还在 `processingKey` 里时才会被搬回：如果它已经被 `listRecover`
   * 回收或已被移除，这次调用就是空操作，不会凭空造出一条消息。
   * @param sourceKey - 待办队列键，元素被放回其队首（LPUSH）
   * @param processingKey - 处理中队列键，元素从这里移除
   * @param entry - 要归还的原始元素值；必须与领取时拿到的字符串完全一致
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  public async listRequeue(
    sourceKey: string,
    processingKey: string,
    entry: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.#evaluate(LIST_REQUEUE_SCRIPT, [sourceKey, processingKey], [entry], signal)
  }

  /**
   * 把处理中队列整体倒回待办队列，用于进程启动时回收上次崩溃遗留的在途消息。
   * 这是**进程级**操作：它假设当前实例是处理中队列的唯一消费者，
   * 若同一队列还有其他活着的消费者，会把别人正在处理的元素也抢回来重复投递。
   * @param sourceKey - 待办队列键，被回收的元素回到其队首
   * @param processingKey - 处理中队列键，被整体清空
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  public async listRecover(
    sourceKey: string,
    processingKey: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.#evaluate(LIST_RECOVER_SCRIPT, [sourceKey, processingKey], [], signal)
  }

  /**
   * 从列表中移除**第一个**与给定值相等的元素，用于处理成功后把元素从处理中队列彻底删掉。
   * 元素不在列表中时是空操作，不算失败——重投、重复回收都可能让同一条消息的
   * 清理被调用两次，幂等是必须的。
   * @param key - 目标列表键
   * @param entry - 要移除的元素值，按字符串精确匹配
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
  public async listRemove(key: string, entry: string, signal: AbortSignal): Promise<void> {
    await this.#evaluate(LIST_REMOVE_SCRIPT, [key], [entry], signal)
  }

  /**
   * 原子追加恢复消息，并刷新其保留时间。
   * 追加与续期必须同一条命令，否则「追加成功但续期前进程挂掉」会留下一个永不过期的列表，
   * 里面的消息再也无人清理。
   * @param key - 目标列表键
   * @param value - 追加的元素，序列化由调用方负责
   * @param ttlSeconds - 刷新后的存活时间（秒）；每次追加都会重置整个列表的过期时间
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   */
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
   * @param guardKey - 守卫键，代表「当前持有者 / 会话代次」
   * @param expectedValue - 守卫键的期望值；与当前值不符即判定守卫失效
   * @param key - 实际追加的目标列表键
   * @param value - 追加的元素，序列化由调用方负责
   * @param ttlSeconds - 刷新后的存活时间（秒）
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否追加成功；`false` 表示守卫已失效、未写入任何内容
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

  /**
   * 守卫键仍是期望值时才删除数据，用于「确认自己仍是持有者后才清理」的场景。
   * 返回 `false` 表示持有者已经换人，本方法什么都没删——这是正常的并发结果，
   * 调用方不应把它当错误上报或重试，因为重试只会得到同样的 `false`。
   * @param guardKey - 守卫键，代表「当前持有者 / 会话代次」
   * @param expectedValue - 守卫键的期望值；与当前值不符即判定守卫失效
   * @param key - 实际删除的目标键
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 是否真的删除；`false` 表示守卫已失效、未做任何修改
   */
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

  /**
   * 原子读取并删除完整的恢复消息列表。
   * 读与删之间不能有别的写入者，否则会漏掉刚追加的消息；也因此它是一次性消费，
   * 调用方必须先把结果落盘或投递成功，再依赖它已经被清空这一事实。
   * @param key - 目标列表键；键不存在时视为空列表，不算失败
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 列表的全部元素；键不存在时为空数组
   */
  public async consumeList(key: string, signal: AbortSignal): Promise<readonly string[]> {
    const result = await this.#evaluate(LIST_CONSUME_SCRIPT, [key], [], signal)
    return redisStringArray(result, 'redis list consume')
  }

  /** 幂等关闭：反复调用共享同一次 `quit()`，不会重复断开。 */
  public close(): Promise<void> {
    this.#closePromise ??= this.#driver.quit().then((): void => undefined)
    return this.#closePromise
  }

  /**
   * 执行一段 Lua，并在命令前后各做一次取消检查；所有列表与比较交换脚本都经这里下发。
   * 它在脚本返回后才检查中止：副作用此时**已经发生**，抛错只表示结果被丢弃，不表示回滚。
   * @param script - Lua 脚本原文
   * @param keys - 作为 `KEYS` 数组传给脚本的键列表
   * @param arguments_ - 作为 `ARGV` 数组传给脚本的参数列表
   * @param signal - 取消信号，命令前后各检查一次，已中止则抛错
   * @returns 脚本的原始返回值，解释方式由各调用方决定
   */
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
 * @param redisUrl - 连接串；协议必须是 `redis:` 或 `rediss:`，格式非法时在建连前就抛错
 * @param signal - 启动期的取消信号，建连与 ping 之后各检查一次
 * @param factory - 驱动工厂，测试可注入假驱动以避开真实网络
 * @returns 已建连并验证过往返的连接对象；失败时抛错且不会返回半连接状态的对象
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

/**
 * 提前拦住明显错误的 URL：空值，以及 `http:` 这类会被 `createClient` 拒掉的协议。
 * 在进 `connectRedis` 前就抛错，避免把配置错误拖到建连阶段才暴露成连接失败。
 * @param value - 待校验的连接串
 */
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

/**
 * Lua 的整数返回值可能是 number 或 bigint（取决于客户端与数值大小），两者都接受。
 * @param value - Lua 的原始返回值
 * @returns 解释后的整数；无法安全解释成整数时抛错，而不是静默当成 0
 */
function redisInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('invalid Redis integer response')
}

/**
 * 把 Lua 的列表返回值收敛成字符串数组。
 * 逐项校验而不是直接断言：驱动返回的形状取决于客户端版本，混进非字符串元素时必须报错，
 * 否则坏数据会一路流进队列消费逻辑，在离根因很远的地方才炸开。
 * @param value - Lua 的原始返回值
 * @param operation - 操作名，仅用于组装错误消息
 * @returns 校验通过的字符串数组；形状不对时抛错
 */
function redisStringArray(value: unknown, operation: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${operation} returned an invalid value`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${operation} returned an invalid value`)
    items.push(item)
  }
  return items
}
