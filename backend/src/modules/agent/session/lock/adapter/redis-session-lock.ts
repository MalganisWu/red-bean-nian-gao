import { randomBytes } from 'node:crypto'
import { normalizeError } from '../../../../../shared/errors/normalize-error.js'

import { REGISTRY_ERROR_CODES, RegistryError } from '../port/session-lock.js'
import type { SessionLease, SessionLockRegistry } from '../port/session-lock.js'

import type { RedisStore } from '../../../../../infra/redis/redis.js'

/**
 * 会话锁的默认 TTL（毫秒），5 分钟。
 *
 * 它要盖过一次正常运行的时长：太短会在运行途中自然过期、被别的实例抢走；
 * 太长则持锁进程崩溃后要拖很久才自然释放，会话长时间无人能跑。
 * 续租间隔由它派生（见 `DEFAULT_RENEW_INTERVAL_MILLISECONDS`），因此这里也是续租频率的源头。
 */
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
  /** 锁的存活毫秒数；缺省用 `DEFAULT_TTL_MILLISECONDS`，必须为正的安全整数。 */
  readonly ttlMilliseconds?: number
  /** 续租间隔毫秒数；缺省按 TTL 的三分之一派生，决定丢失多久后能被发现。 */
  readonly renewIntervalMilliseconds?: number
  /** 围栏序号来源；缺省用进程内自增兜底，多实例部署应注入数据库序列之类的全局源。 */
  readonly nextFencingToken?: () => Promise<bigint>
  /** owner 随机串来源；缺省用随机字节，测试可注入固定值以产出确定的 owner。 */
  readonly nonce?: () => string
  /** 后台续租出错时的回调；缺省静默，宿主可借此上报监控而不影响主流程。 */
  readonly onRenewalError?: (error: Error) => void
}

/** Redis 会话锁实现，同时满足对话、投递和调度三个消费方的窄 Port。 */
export class RedisSessionLockRegistry implements SessionLockRegistry {
  /** 底层 Redis 连接；锁键与续租均经它操作。 */
  readonly #redis: RedisStore
  /** 本次实例使用的锁 TTL（毫秒），构造时经校验固定。 */
  readonly #ttlMilliseconds: number
  /** 续租间隔（毫秒），构造时经校验固定。 */
  readonly #renewIntervalMilliseconds: number
  /** 围栏序号来源；抢锁前先取值，失败也不复用已消耗的序号。 */
  readonly #nextFencingToken: () => Promise<bigint>
  /** owner 随机串来源；保证同一 requestId 重试时 owner 仍不同。 */
  readonly #nonce: () => string
  /** 后台续租错误回调；默认空实现，见 `RedisSessionLockRegistryOptions`。 */
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
   *
   * @param sessionId - 目标会话标识，决定锁键 `session_lock:<id>`，同一会话的并发运行在此互斥。
   * @param requestId - 本次运行标识，参与拼装 owner，用于区分同一会话的不同请求。
   * @param parent - 调用方取消信号，可选；缺省时用永不中止的内部信号，因为抢锁本身不该被半途放弃。
   * @returns 已持有的租约，持有者必须负责 `release()`。
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

/**
 * 单把 Redis 租约的构造参数；由 `RedisSessionLockRegistry.tryAcquire` 抢锁成功后组装传入。
 * 除 `redis` 外都是本次抢锁已经确定下来的值，锁实例不再回头向注册表取任何东西，
 * 于是它可以脱离注册表单独构造与测试。
 */
interface RedisSessionLockOptions {
  /** 底层 Redis 连接；续租与释放经它操作锁键。 */
  readonly redis: RedisStore
  /** 锁键名；同一会话的并发运行在同一个键上互斥。 */
  readonly key: string
  /** 所有权标识；`compareAndExpire` / `compareAndDelete` 据此确认操作的是自己的锁。 */
  readonly owner: string
  /** 本次抢到的围栏序号；释放前任一写入都应带上它。 */
  readonly fencingToken: bigint
  /** 续租时刷新的锁 TTL（毫秒）。 */
  readonly ttlMilliseconds: number
  /** 后台续租的定时器间隔（毫秒）。 */
  readonly renewIntervalMilliseconds: number
  /** 调用方取消信号；缺省表示抢锁时没传，行为上不监听父中止。 */
  readonly parent: AbortSignal | undefined
  /** 后台续租错误回调；缺省为空实现。 */
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
  /** 单调递增的围栏序号；回写到仓储后，旧序号实例的写入会被判为陈旧而拒绝。 */
  public readonly fencingToken: bigint
  /** 写证明：Store 用它核对「这次写入确实来自当前锁持有者」。 */
  public readonly writeProof: string
  /** 丢失信号；只 resolve 一次的 Promise，续租发现锁已易主时兑现，持有者据此停止写入。 */
  public readonly lost: Promise<Error>
  /** 底层 Redis 连接；续租与释放经它操作锁键。 */
  readonly #redis: RedisStore
  /** 锁键名；只操作这一个键，不触碰别的会话。 */
  readonly #key: string
  /** 所有权标识；`compareAndExpire` / `compareAndDelete` 据此确认锁仍属于自己。 */
  readonly #owner: string
  /** 续租时刷新的锁 TTL（毫秒）。 */
  readonly #ttlMilliseconds: number
  /** 调用方取消信号；缺省表示未传，此时不注册父中止监听。 */
  readonly #parent: AbortSignal | undefined
  /** 后台续租错误回调。 */
  readonly #onRenewalError: (error: Error) => void
  /** `lost` 的兑现句柄；只调用一次，兑现后 `lost` 从挂起转为 resolved。 */
  readonly #resolveLost: (error: Error) => void
  /** 父信号中止时的监听器；缺省表示无父信号，无需注册。 */
  readonly #onParentAbort: (() => void) | undefined
  /** 后台续租定时器句柄；释放或丢失后置为 undefined，防止泄漏。 */
  #renewTimer: NodeJS.Timeout | undefined
  /** 丢失是否已兑现；保证 `lost` 只 resolve 一次，重复判定直接返回。 */
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

  /** 定时器触发的后台续租；把续租异常交给回调而不是任其成为未处理的 rejection。 */
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

  /** 停止续租定时器并摘掉父中止监听；幂等，释放与丢失路径都会调用。 */
  #stopRenewal(): void {
    if (this.#renewTimer !== undefined) clearInterval(this.#renewTimer)
    this.#renewTimer = undefined
    if (this.#parent !== undefined && this.#onParentAbort !== undefined) {
      this.#parent.removeEventListener('abort', this.#onParentAbort)
    }
  }
}

/**
 * 手工兑现的 Promise 句柄。`lost` 需要「在创建后任意时刻、且只兑现一次」，
 * 而普通 Promise 的 executor 无法把 resolve 暴露到外部作用域，于是用这个结构把它装出来。
 */
interface DeferredError {
  /** 由外部持有的挂起句柄；在丢失事件发生前一直不兑现。 */
  readonly promise: Promise<Error>
  /** 兑现 `promise` 的句柄；调用方在需要时手动调用，只应调用一次。 */
  readonly resolve: (error: Error) => void
}

/**
 * 构造一个可由外部兑现的 Promise 及其 resolve 句柄。
 * 刻意不在 executor 里同步兑现：返回后由持有者在租约丢失时自行 resolve，
 * 保证 `lost` 在创建后长期挂起，直到真的有丢失事件才兑现。
 *
 * @returns promise 与它对应的 resolve；调用方持有 resolve 直到需要兑现。
 */
function deferredError(): DeferredError {
  let resolvePromise: ((error: Error) => void) | undefined
  const promise = new Promise<Error>((resolve) => {
    resolvePromise = resolve
  })
  if (resolvePromise === undefined) throw new Error('failed to initialize lease loss promise')
  return { promise, resolve: resolvePromise }
}

/**
 * 兜底 token 源：进程内自增。跨实例正确性见 `fallbackFencingToken` 的说明。
 *
 * @returns 自增后的围栏序号；同一进程内严格递增，跨进程不保证。
 */
function nextFallbackFencingToken(): Promise<bigint> {
  fallbackFencingToken += 1n
  return Promise.resolve(fallbackFencingToken)
}

/**
 * 校验毫秒配置为正的安全整数；不合法时立刻抛错而不是回退默认值——
 * 配置写错应当在使用前暴露，静默替换成默认值会让人误以为设置已经生效。
 *
 * @param value - 待校验的毫秒值。
 * @param name - 配置项名称，只用于拼装错误信息，便于从日志认出是哪一项写错。
 * @returns 通过校验的原值。
 */
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
 *
 * @returns 全新的、不会被中止的 AbortSignal。
 */
function liveSignal(): AbortSignal {
  return new AbortController().signal
}
