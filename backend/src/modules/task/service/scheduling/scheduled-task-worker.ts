import type { Logger } from './../../../../infra/logger/logger.js'
import { abortableDelay } from './../../../../shared/async/abortable-delay.js'
import { normalizeError } from './../../../../shared/errors/normalize-error.js'
import type { TaskSchedulerPort } from './port/task-scheduler.port.js'

/**
 * Task Module 的进程级入站适配器：只负责定时触发扫描与停机，不承载调度业务规则。
 */
export class ScheduledTaskWorker {
  readonly #scheduler: TaskSchedulerPort
  readonly #logger: Logger
  readonly #scanIntervalMilliseconds: number
  readonly #stopController = new AbortController()
  #started = false

  public constructor(
    scheduler: TaskSchedulerPort,
    logger: Logger,
    scanIntervalMilliseconds: number
  ) {
    if (!Number.isSafeInteger(scanIntervalMilliseconds) || scanIntervalMilliseconds <= 0) {
      throw new Error('扫描间隔必须大于 0')
    }
    this.#scheduler = scheduler
    this.#logger = logger
    this.#scanIntervalMilliseconds = scanIntervalMilliseconds
  }

  public async start(parent: AbortSignal): Promise<void> {
    if (this.#started) throw new Error('scheduled task worker already started')
    this.#started = true
    const signal = AbortSignal.any([parent, this.#stopController.signal])
    this.#logger.info('scheduled task worker started', {
      scan_interval_ms: this.#scanIntervalMilliseconds,
    })
    try {
      while (!signal.aborted) {
        await abortableDelay(this.#scanIntervalMilliseconds, signal)
        if (!signal.aborted) await this.#scheduler.scanOnce(signal)
      }
    } catch (cause: unknown) {
      if (!signal.aborted) {
        this.#logger.error('scheduled task worker loop failed', { error: normalizeError(cause) })
      }
    } finally {
      await this.#scheduler.waitForIdle()
      this.#logger.info(
        parent.aborted ? 'scheduled task worker context cancelled' : 'scheduled task worker stopped'
      )
    }
  }

  public async stop(): Promise<void> {
    this.#stopController.abort(new Error('scheduled task worker stopped'))
    await this.#scheduler.waitForIdle()
  }
}
