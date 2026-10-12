import { REGISTRY_ERROR_CODES, RegistryError } from '../../session/lock/port/session-lock.js'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'

import type { RedisStore } from '../../../../infra/redis/redis.js'
import type { CancelRegistryPort } from '../port/cancellation-registry.port.js'

const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 500

interface CancelEntry {
  readonly controller: AbortController
  readonly timeoutTimer: NodeJS.Timeout
  readonly parent: AbortSignal | undefined
  readonly onParentAbort: (() => void) | undefined
  pollTimer: NodeJS.Timeout | undefined
}

/** 取消注册表选项；前者是取消键的存活时间，后者是跨实例的轮询间隔。 */
export interface RedisCancelRegistryOptions {
  readonly timeoutMilliseconds?: number
  readonly pollIntervalMilliseconds?: number
}

/**
 * `CancelRegistryPort` 的 Redis 实现，同时保留同进程 AbortController。
 *
 * **两层机制缺一不可**，这是本类最需要理解的地方：
 * - **本地 AbortController**：让本实例的取消立即生效，不走网络。
 * - **Redis 键 + 轮询**：让**别的实例**发起的取消也能被本实例发现。
 *   没有它就只能取消自己进程里的请求；有了它，用户在 A 实例点「停止」，B 实例上跑的同一请求也会停。
 *
 * 轮询而不是订阅（Pub/Sub）：订阅需要长连接与断线重连管理，且消息在断线期间会丢；
 * 而取消信号是幂等的、可容忍延迟的状态查询，用轮询换取实现简单与断线安全是划算的。
 *
 * 代价是取消延迟上界 = `pollIntervalMilliseconds`（默认 500ms），以及每个在途请求一份轮询定时器。
 */
export class RedisCancelRegistry implements CancelRegistryPort {
  readonly #redis: RedisStore
  readonly #entries = new Map<string, CancelEntry>()
  readonly #timeoutMilliseconds: number
  readonly #pollIntervalMilliseconds: number

  public constructor(redis: RedisStore, options: RedisCancelRegistryOptions = {}) {
    this.#redis = redis
    this.#timeoutMilliseconds = positiveMilliseconds(
      options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
      'timeoutMilliseconds'
    )
    this.#pollIntervalMilliseconds = positiveMilliseconds(
      options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS,
      'pollIntervalMilliseconds'
    )
  }

  /**
   * 为一次请求建立可取消的信号，并登记到 Redis 供其他实例发现。
   *
   * `requestId` 重复即报错：同 ID 的第二份登记会覆盖第一份的轮询定时器，
   * 前一个请求就再也收不到取消信号了。
   * Redis 写入失败时把本地登记也一并撤掉再抛——留下一个「只有本地有效、别的实例取消不了」
   * 的残状态，比直接失败更难排查。
   */
  public async wrap(parent: AbortSignal | undefined, requestId: string): Promise<AbortSignal> {
    if (this.#entries.has(requestId)) {
      throw new RegistryError(REGISTRY_ERROR_CODES.REQUEST_ALREADY_REGISTERED)
    }

    const controller = new AbortController()
    const onParentAbort =
      parent === undefined
        ? undefined
        : (): void => {
            controller.abort(parent.reason)
          }
    if (parent?.aborted === true) controller.abort(parent.reason)
    else if (parent !== undefined && onParentAbort !== undefined) {
      parent.addEventListener('abort', onParentAbort, { once: true })
    }
    const timeoutTimer = setTimeout((): void => {
      controller.abort(new DOMException('request timed out', 'TimeoutError'))
    }, this.#timeoutMilliseconds)
    timeoutTimer.unref()
    const entry: CancelEntry = {
      controller,
      timeoutTimer,
      parent,
      onParentAbort,
      pollTimer: undefined,
    }
    this.#entries.set(requestId, entry)

    try {
      await this.#redis.set(
        this.#key(requestId),
        'active',
        this.#timeoutMilliseconds,
        controller.signal
      )
    } catch (cause: unknown) {
      this.#removeLocal(requestId, entry)
      controller.abort(cause)
      throw new Error(`写入 Redis 取消 key 失败: ${normalizeError(cause).message}`, { cause })
    }
    this.#schedulePoll(requestId, entry)
    return controller.signal
  }

  /**
   * 取消一次请求，返回「是否确实取消到了什么」。
   *
   * 两条路径的**容错策略刻意不同**：
   * - **本地命中**（请求就在本实例跑）：写 Redis 是尽力而为，失败也吞掉，
   *   并且无条件本地中止。理由是同实例取消不该依赖 Redis 可用性——
   *   Redis 挂了就让用户点不动「停止」，是把基础设施故障放大成功能缺失。
   * - **本地未命中**（请求在别的实例）：只能靠 Redis 传递，因此失败必须抛出，
   *   否则会返回一个「成功」但实际没人收到信号的假象。
   *
   * 返回值语义：`false` 表示这个 requestId 根本不存在（可能已经结束或被回收）；
   * 已被别人标成 cancelled 时返回 `true`——幂等，重复取消不算失败。
   */
  public async cancel(requestId: string): Promise<boolean> {
    const entry = this.#entries.get(requestId)
    if (entry !== undefined) {
      try {
        await this.#redis.set(
          this.#key(requestId),
          'cancelled',
          this.#timeoutMilliseconds,
          liveSignal()
        )
      } catch {
        // Redis 中断时，同实例取消仍必须可用。
      }
      entry.controller.abort(new DOMException('request cancelled', 'AbortError'))
      this.#stopPolling(entry)
      return true
    }

    let existing: string | undefined
    try {
      existing = await this.#redis.get(this.#key(requestId), liveSignal())
    } catch (cause: unknown) {
      throw new Error(`查询 Redis 取消 key 失败: ${normalizeError(cause).message}`, { cause })
    }
    if (existing === undefined) return false
    if (existing === 'cancelled') return true
    try {
      await this.#redis.set(
        this.#key(requestId),
        'cancelled',
        this.#timeoutMilliseconds,
        liveSignal()
      )
    } catch (cause: unknown) {
      throw new Error(`写入 Redis 取消信号失败: ${normalizeError(cause).message}`, { cause })
    }
    return true
  }

  /** 请求正常结束时注销：先撤本地登记（幂等保护随之失效），再删 Redis 键。 */
  public async deregister(requestId: string): Promise<void> {
    const entry = this.#entries.get(requestId)
    if (entry !== undefined) this.#removeLocal(requestId, entry)
    try {
      await this.#redis.delete(this.#key(requestId), liveSignal())
    } catch (cause: unknown) {
      throw new Error(`删除 Redis 取消 key 失败: ${normalizeError(cause).message}`, { cause })
    }
  }

  /**
   * 安排下一次轮询。
   *
   * 两重守卫：信号已中止就不必再查；`#entries.get(requestId) !== entry` 则保证
   * **旧的定时器不会作用到后来重新登记的同名请求上**——没有这一句，
   * 一次 deregister + 重新 wrap（同 requestId）会让旧定时器把新请求误判为已取消。
   */
  #schedulePoll(requestId: string, entry: CancelEntry): void {
    if (entry.controller.signal.aborted || this.#entries.get(requestId) !== entry) return
    entry.pollTimer = setTimeout((): void => {
      void this.#poll(requestId, entry)
    }, this.#pollIntervalMilliseconds)
    entry.pollTimer.unref()
  }

  /**
   * 查一次 Redis 看别的实例有没有取消这个请求；查完再排下一次，形成自续的轮询链。
   * Redis 瞬时错误只跳过本轮，不中断轮询——网络抖一下就让请求永远失去跨实例取消能力是不可接受的。
   */
  async #poll(requestId: string, entry: CancelEntry): Promise<void> {
    if (entry.controller.signal.aborted || this.#entries.get(requestId) !== entry) return
    try {
      const value = await this.#redis.get(this.#key(requestId), entry.controller.signal)
      if (value === 'cancelled') {
        entry.controller.abort(new DOMException('request cancelled', 'AbortError'))
        this.#stopPolling(entry)
        return
      }
    } catch {
      // Redis 瞬时错误不能终止本地请求的取消监听。
    }
    this.#schedulePoll(requestId, entry)
  }

  /** 撤销本地登记；删除前的同一性检查防止把重新登记后的新条目误删。 */
  #removeLocal(requestId: string, entry: CancelEntry): void {
    if (this.#entries.get(requestId) === entry) this.#entries.delete(requestId)
    clearTimeout(entry.timeoutTimer)
    this.#stopPolling(entry)
    if (entry.parent !== undefined && entry.onParentAbort !== undefined) {
      entry.parent.removeEventListener('abort', entry.onParentAbort)
    }
  }

  #stopPolling(entry: CancelEntry): void {
    if (entry.pollTimer !== undefined) clearTimeout(entry.pollTimer)
    entry.pollTimer = undefined
  }

  #key(requestId: string): string {
    return `agent:cancel:${requestId}`
  }
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
