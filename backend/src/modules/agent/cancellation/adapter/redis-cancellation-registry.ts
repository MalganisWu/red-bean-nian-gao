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

export interface RedisCancelRegistryOptions {
  readonly timeoutMilliseconds?: number
  readonly pollIntervalMilliseconds?: number
}

/** `CancelRegistryPort` 的 Redis 实现，同时保留同进程 AbortController。 */
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

  public async deregister(requestId: string): Promise<void> {
    const entry = this.#entries.get(requestId)
    if (entry !== undefined) this.#removeLocal(requestId, entry)
    try {
      await this.#redis.delete(this.#key(requestId), liveSignal())
    } catch (cause: unknown) {
      throw new Error(`删除 Redis 取消 key 失败: ${normalizeError(cause).message}`, { cause })
    }
  }

  #schedulePoll(requestId: string, entry: CancelEntry): void {
    if (entry.controller.signal.aborted || this.#entries.get(requestId) !== entry) return
    entry.pollTimer = setTimeout((): void => {
      void this.#poll(requestId, entry)
    }, this.#pollIntervalMilliseconds)
    entry.pollTimer.unref()
  }

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
