import type { SubExecutionRepository } from '../../repository/port/sub-execution-repository.port.js'
import type { ChildExecutionLease } from '../port/child-execution-lifecycle.port.js'

/**
 * 为一次 Sub-Agent resume 持续续租 revision 所有权。
 * 续租失败或本地租期到期都会中止执行，避免旧 owner 提交结果。
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
