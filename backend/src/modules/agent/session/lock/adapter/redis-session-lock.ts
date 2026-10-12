import { randomBytes } from 'node:crypto'
import { normalizeError } from '../../../../../shared/errors/normalize-error.js'

import { REGISTRY_ERROR_CODES, RegistryError } from '../port/session-lock.js'
import type { SessionLease, SessionLockRegistry } from '../port/session-lock.js'

import type { RedisStore } from '../../../../../infra/redis/redis.js'

const DEFAULT_TTL_MILLISECONDS = 300_000
/** 每 1/3 个 TTL 续一次：连续两次续租失败后仍剩 1/3 TTL 的余量，不至于一抖动就丢锁。 */
const DEFAULT_RENEW_INTERVAL_MILLISECONDS = DEFAULT_TTL_MILLISECONDS / 3

/**
 * 未注入 `nextFencingToken` 时的兜底序号：进程内单调递增，种子取当前毫秒。
 *
 * ⚠️ 它只能保证**单进程内**单调。多实例部署时若各进程时钟有偏差，
 * 后启动的实例可能发出比前者更小的 token，checkpoint 的 fencing 会把它判成陈旧而拒写。
 * 需要跨实例正确性的宿主必须注入自己的 token 源（例如数据库序列）。
 */
let fallbackFencingToken = BigInt(Date.now()) * 1_000_000n

/** 锁参数；`nextFencingToken` 与 `nonce` 可注入，测试因此能产出确定的围栏值与随机串。 */
export interface RedisSessionLockRegistryOptions {
  readonly ttlMilliseconds?: number
  readonly renewIntervalMilliseconds?: number
  readonly nextFencingToken?: () => Promise<bigint>
  readonly nonce?: () => string
  readonly onRenewalError?: (error: Error) => void
}

/** Redis 会话锁实现，同时满足对话、投递和调度三个消费方的窄 Port。 */
export class RedisSessionLockRegistry implements SessionLockRegistry {
  readonly #redis: RedisStore
  readonly #ttlMilliseconds: number
  readonly #renewIntervalMilliseconds: number
  readonly #nextFencingToken: () => Promise<bigint>
  readonly #nonce: () => string
  readonly #onRenewalError: (error: Error) => void

  public constructor(redis: RedisStore, options: RedisSessionLockRegistryOptions = {}) {
    this.#redis = redis
    this.#ttlMilliseconds = positiveMilliseconds(
      options.ttlMilliseconds ?? DEFAULT_TTL_MILLISECONDS,
      'ttlMilliseconds'
    )
    this.#renewIntervalMilliseconds = positiveMilliseconds(
      options.renewIntervalMilliseconds ?? DEFAULT_RENEW_INTERVAL_MILLISECONDS,
      'renewIntervalMilliseconds'
    )
    this.#nextFencingToken = options.nextFencingToken ?? nextFallbackFencingToken
    this.#nonce = options.nonce ?? ((): string => randomBytes(12).toString('hex'))
    this.#onRenewalError = options.onRenewalError ?? ((): void => undefined)
  }

  /**
   * 尝试获取会话锁；拿不到抛 `LOCK_CONFLICT`（而不是返回 undefined），
   * 因为调用方必须显式处理「有人正在跑」这件事，静默失败会变成难以察觉的跳过。
   *
   * **token 在抢锁之前生成**：即使这次 SetNX 失败，序号也已经消耗掉了。
   * 这是刻意的——token 一旦生成就不该复用，否则一次失败的抢锁与一次成功的抢锁可能带上同一个序号，
   * fencing 的「严格递增」判别力就没了。
   *
   * `owner` 由 `requestId:fencingToken:nonce` 拼成。nonce 是关键：同一个 requestId 重试时
   * owner 必须不同，否则新持有者会与旧持有者的 `compareAndDelete` 撞上同一个值，
   * 把别人的锁当成自己的删掉。
   */
  public async tryAcquire(
    sessionId: string,
    requestId: string,
    parent?: AbortSignal
  ): Promise<RedisSessionLock> {
    let fencingToken: bigint
    try {
      fencingToken = await this.#nextFencingToken()
    } catch (cause: unknown) {
      throw new Error(`生成 fencing token 失败: ${normalizeError(cause).message}`, { cause })
    }
    if (fencingToken <= 0n) throw new Error('fencing token must be greater than zero')
    const key = `session_lock:${sessionId}`
    const owner = `${requestId}:${String(fencingToken)}:${this.#nonce()}`
    let acquired: boolean
    try {
      acquired = await this.#redis.setIfAbsent(
        key,
        owner,
        this.#ttlMilliseconds,
        parent ?? liveSignal()
      )
    } catch (cause: unknown) {
      throw new Error(`redis SetNX 失败: ${normalizeError(cause).message}`, { cause })
    }
    if (!acquired) throw new RegistryError(REGISTRY_ERROR_CODES.LOCK_CONFLICT)
    return new RedisSessionLock({
      redis: this.#redis,
      key,
      owner,
      fencingToken,
      ttlMilliseconds: this.#ttlMilliseconds,
      renewIntervalMilliseconds: this.#renewIntervalMilliseconds,
      parent,
      onRenewalError: this.#onRenewalError,
    })
  }
}

interface RedisSessionLockOptions {
  readonly redis: RedisStore
  readonly key: string
  readonly owner: string
  readonly fencingToken: bigint
  readonly ttlMilliseconds: number
  readonly renewIntervalMilliseconds: number
  readonly parent: AbortSignal | undefined
  readonly onRenewalError: (error: Error) => void
}

/**
 * 单次 Redis Session lease；由 `RedisSessionLockRegistry` 创建并把续租失败暴露为 `lost`。
 * 持有者负责调用 `release()`，释放操作会同时停止定时续租和父取消监听。
 *
 * **`lost` 是这份租约的核心契约**：它是一个只 resolve 一次的 Promise，
 * 在续租发现锁已不属于自己时兑现。持有者必须监听它并停止写入——
 * 此时别的实例已经拿到了锁，继续写就是并发覆盖。
 * 注意两点：
 * - 主动 `release()` **不会**触发 `lost`（那是自愿放弃，不是失控）。
 * - 父信号中止只**停止续租**，不释放锁也不触发 `lost`；锁会在 TTL 后自然过期。
 *   这是为了不把「调用方取消了」误报成「租约丢了」。
 */
export class RedisSessionLock implements SessionLease {
  public readonly fencingToken: bigint
  /** 写证明：Store 用它核对「这次写入确实来自当前锁持有者」。 */
  public readonly writeProof: string
  public readonly lost: Promise<Error>
  readonly #redis: RedisStore
  readonly #key: string
  readonly #owner: string
  readonly #ttlMilliseconds: number
  readonly #parent: AbortSignal | undefined
  readonly #onRenewalError: (error: Error) => void
  readonly #resolveLost: (error: Error) => void
  readonly #onParentAbort: (() => void) | undefined
  #renewTimer: NodeJS.Timeout | undefined
  #lostSignaled = false

  public constructor(options: RedisSessionLockOptions) {
    this.#redis = options.redis
    this.#key = options.key
    this.#owner = options.owner
    this.writeProof = options.owner
    this.fencingToken = options.fencingToken
    this.#ttlMilliseconds = options.ttlMilliseconds
    this.#parent = options.parent
    this.#onRenewalError = options.onRenewalError
    const deferred = deferredError()
    this.lost = deferred.promise
    this.#resolveLost = deferred.resolve
    this.#onParentAbort =
      this.#parent === undefined
        ? undefined
        : (): void => {
            this.#stopRenewal()
          }
    if (this.#parent?.aborted !== true && this.#onParentAbort !== undefined) {
      this.#parent?.addEventListener('abort', this.#onParentAbort, { once: true })
    }
    this.#renewTimer = setInterval((): void => {
      void this.#renewInBackground()
    }, options.renewIntervalMilliseconds)
    this.#renewTimer.unref()
  }

  /** 立刻续租一次。续租失败（键已不属于自己）即判定租约丢失，不重试——重试只会反复确认同一件事。 */
  public async renewNow(): Promise<void> {
    const renewed = await this.#redis.compareAndExpire(
      this.#key,
      this.#owner,
      this.#ttlMilliseconds,
      liveSignal()
    )
    if (!renewed) this.#markLost()
  }

  /**
   * 主动释放。先停续租再删键，顺序不能反：反过来的话，删完到停表之间的一次续租
   * 会把一个已经被删除的键重新续上（`compareAndExpire` 在键不存在时返回 0，不会重建，
   * 但先停表语义更清晰，也少一次无谓往返）。
   * 用 `compareAndDelete` 而非 `delete`：只删属于自己的那一把，见 redis.ts 的说明。
   */
  public async release(): Promise<void> {
    this.#stopRenewal()
    try {
      await this.#redis.compareAndDelete(this.#key, this.#owner, liveSignal())
    } catch (cause: unknown) {
      throw new Error(`redis Eval 失败: ${normalizeError(cause).message}`, { cause })
    }
  }

  async #renewInBackground(): Promise<void> {
    try {
      await this.renewNow()
    } catch (cause: unknown) {
      this.#onRenewalError(normalizeError(cause))
    }
  }

  /** 幂等：`lost` 只兑现一次，后续的丢失判定直接返回，避免重复 resolve 与重复清理。 */
  #markLost(): void {
    if (this.#lostSignaled) return
    this.#lostSignaled = true
    this.#stopRenewal()
    this.#resolveLost(new RegistryError(REGISTRY_ERROR_CODES.LEASE_LOST))
  }

  #stopRenewal(): void {
    if (this.#renewTimer !== undefined) clearInterval(this.#renewTimer)
    this.#renewTimer = undefined
    if (this.#parent !== undefined && this.#onParentAbort !== undefined) {
      this.#parent.removeEventListener('abort', this.#onParentAbort)
    }
  }
}

interface DeferredError {
  readonly promise: Promise<Error>
  readonly resolve: (error: Error) => void
}

function deferredError(): DeferredError {
  let resolvePromise: ((error: Error) => void) | undefined
  const promise = new Promise<Error>((resolve) => {
    resolvePromise = resolve
  })
  if (resolvePromise === undefined) throw new Error('failed to initialize lease loss promise')
  return { promise, resolve: resolvePromise }
}

/** 兜底 token 源：进程内自增。跨实例正确性见 `fallbackFencingToken` 的说明。 */
function nextFallbackFencingToken(): Promise<bigint> {
  fallbackFencingToken += 1n
  return Promise.resolve(fallbackFencingToken)
}

function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

/**
 * 一个永不会中止的信号。
 * 续租与释放这类「必须完成」的内部操作不该受调用方取消影响：
 * 取消到一半撒手不管，锁会一直留到 TTL 过期，期间谁也拿不到。
 */
function liveSignal(): AbortSignal {
  return new AbortController().signal
}
