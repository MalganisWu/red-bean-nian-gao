import type { SubExecutionRepository } from '../../repository/port/sub-execution-repository.port.js'
import type { ChildExecutionLease } from '../port/child-execution-lifecycle.port.js'

/**
 * 为一次 Sub-Agent resume 持续续租 revision 所有权。
 * 续租失败或本地租期到期都会中止执行，避免旧 owner 提交结果。
 *
 * 两个定时器各管一条失效路径，缺一不可：
 * - **心跳**：到点续租，成功后重新排期（同时重置过期计时器）。
 * - **过期**：租期的硬上限。即便心跳一直在跑，只要没续成功就不能无限期持有——
 *   续租请求可能一直排队而没有任何一次失败，光靠心跳的失败分支等不到中止。
 *
 * 两条路径都收敛到 `#controller.abort()`，调用方只需看 `lease.signal.aborted`
 * 就能在保存前发现自己已经不该写了。
 */
export class RevisionHeartbeatLease implements ChildExecutionLease {
  readonly #repository: SubExecutionRepository
  readonly #executionId: string
  readonly #revision: bigint
  readonly #leaseMilliseconds: number
  readonly #heartbeatMilliseconds: number
  readonly #now: () => Date
  readonly #controller = new AbortController()
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  #expiryTimer: ReturnType<typeof setTimeout> | undefined
  #released = false

  public constructor(
    repository: SubExecutionRepository,
    executionId: string,
    revision: bigint,
    leaseMilliseconds: number,
    heartbeatMilliseconds: number,
    now: () => Date
  ) {
    if (
      leaseMilliseconds <= 0 ||
      heartbeatMilliseconds <= 0 ||
      heartbeatMilliseconds >= leaseMilliseconds
    ) {
      throw new RangeError('resume lease 配置无效')
    }
    this.#repository = repository
    this.#executionId = executionId
    this.#revision = revision
    this.#leaseMilliseconds = leaseMilliseconds
    this.#heartbeatMilliseconds = heartbeatMilliseconds
    this.#now = now
    this.#schedule()
  }

  public get signal(): AbortSignal {
    return this.#controller.signal
  }

  public release(): void {
    this.#released = true
    clearTimeout(this.#heartbeatTimer)
    clearTimeout(this.#expiryTimer)
  }

  /** 重排两个定时器；每次续租成功都会调用，因此过期时刻随之前移（这是「续租」的本义）。 */
  #schedule(): void {
    clearTimeout(this.#expiryTimer)
    this.#expiryTimer = setTimeout((): void => {
      this.#controller.abort(new Error('sub execution resume lease 已过期'))
    }, this.#leaseMilliseconds)
    this.#expiryTimer.unref()
    this.#heartbeatTimer = setTimeout((): void => {
      void this.#renew()
    }, this.#heartbeatMilliseconds)
    this.#heartbeatTimer.unref()
  }

  /**
   * 续租一次。续租请求自己带 5s 超时（且不超过心跳间隔），避免一次卡住的续租
   * 拖过长心跳周期、把正常的续租节奏挤掉。
   * 成功后重新排期；失败即中止——重试没有意义，续不上说明所有权已经不属于自己了。
   */
  async #renew(): Promise<void> {
    if (this.#released || this.#controller.signal.aborted) return
    try {
      await this.#repository.renewResumeLease(
        this.#executionId,
        this.#revision,
        this.#now(),
        AbortSignal.timeout(Math.min(this.#heartbeatMilliseconds, 5_000))
      )
      if (!this.#released) this.#schedule()
    } catch (cause: unknown) {
      if (!this.#released) {
        this.#controller.abort(
          cause instanceof Error ? cause : new Error('sub execution resume lease 续租失败')
        )
      }
    }
  }
}
