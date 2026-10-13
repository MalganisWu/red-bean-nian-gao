import type { Logger } from './../../../../infra/logger/logger.js'
import { abortableDelay } from './../../../../shared/async/abortable-delay.js'
import { normalizeError } from './../../../../shared/errors/normalize-error.js'
import type { TaskSchedulerPort } from './port/task-scheduler.port.js'

/**
 * Task Module 的进程级入站适配器：只负责定时触发扫描与停机，不承载调度业务规则。
 */
export class ScheduledTaskWorker {
  /** 调度 Port；本适配器只负责定时触发它，不承载调度规则。 */
  readonly #scheduler: TaskSchedulerPort
  /** 日志出口；循环起停与失败都经它记录。 */
  readonly #logger: Logger
  /** 扫描间隔（毫秒）；构造时校验为正整数。 */
  readonly #scanIntervalMilliseconds: number
  /** 内部停止信号源；`stop` 中止它，并与父信号合并后中断循环。 */
  readonly #stopController = new AbortController()
  /** 是否已启动过；循环只允许起一次，重复启动直接抛错。 */
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

  /**
   * 启动扫描循环，直到父信号中止或 `stop` 被调用；首次扫描刻意延后一个间隔，
   * 避开进程启动期的数据库迁移与连接池预热。重复调用会抛错，循环只允许起一次。
   *
   * @param parent - 父级停止信号，与内部停止信号合并后一并中断循环。
   */
  public async start(parent: AbortSignal): Promise<void> {
    if (this.#started) throw new Error('scheduled task worker already started')
    this.#started = true
    const signal = AbortSignal.any([parent, this.#stopController.signal])
    this.#logger.info('scheduled task worker started', {
      scan_interval_ms: this.#scanIntervalMilliseconds,
    })
    /*
     * 先等一个扫描间隔再扫，而不是立刻扫一次：进程刚起来时数据库迁移、连接池预热都还没稳，
     * 抢着扫只会拿到一堆瞬时失败。代价是启动后最多有一个间隔的调度延迟——
     * 对分钟级的定时任务可以接受，也避免了启动期的抖动。
     */
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

  /**
   * 停止扫描循环并等待在途 worker 排空；abort 幂等，可重复调用。
   */
  public async stop(): Promise<void> {
    this.#stopController.abort(new Error('scheduled task worker stopped'))
    await this.#scheduler.waitForIdle()
  }
}
