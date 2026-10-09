import { randomBytes } from 'node:crypto'
import { normalizeError } from '../../../../../shared/errors/normalize-error.js'

import { REGISTRY_ERROR_CODES, RegistryError } from '../port/session-lock.js'
import type { SessionLease, SessionLockRegistry } from '../port/session-lock.js'

import type { RedisStore } from '../../../../../infra/redis/redis.js'

const DEFAULT_TTL_MILLISECONDS = 300_000
const DEFAULT_RENEW_INTERVAL_MILLISECONDS = DEFAULT_TTL_MILLISECONDS / 3

let fallbackFencingToken = BigInt(Date.now()) * 1_000_000n

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
 */
export class RedisSessionLock implements SessionLease {
  public readonly fencingToken: bigint
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

  public async renewNow(): Promise<void> {
    const renewed = await this.#redis.compareAndExpire(
      this.#key,
      this.#owner,
      this.#ttlMilliseconds,
      liveSignal()
    )
    if (!renewed) this.#markLost()
  }

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

function liveSignal(): AbortSignal {
  return new AbortController().signal
}
