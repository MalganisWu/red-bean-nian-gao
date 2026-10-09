import { REGISTRY_ERROR_CODES, RegistryError } from './../../../agent/public-api.js'
import { normalizeError } from './../../../../shared/errors/normalize-error.js'

import type { AgentTaskDefinition } from './../../model/task.js'
import type { Logger } from './../../../../infra/logger/logger.js'
import type {
  PendingTaskRepository,
  ScheduledTaskLease,
  ScheduledTaskLockRegistry,
  ScheduledTaskPipeline,
  SchedulerConfig,
  TaskSchedulerPort,
} from './port/task-scheduler.port.js'

const LOCK_OWNER = 'scheduler'
const WORKER_DRAIN_TIMEOUT_MILLISECONDS = 30_000

/**
 * Task Module 的默认调度实现，由 `task.module.ts` 绑定到 `TaskSchedulerPort`。
 * 它拥有并发执行集合与停机排空责任；单次任务的持久化、重试和投递交给注入的执行 Port。
 */
export class ScheduledTaskScheduler implements TaskSchedulerPort {
  readonly #repository: PendingTaskRepository
  readonly #pipeline: ScheduledTaskPipeline
  readonly #lockRegistry: ScheduledTaskLockRegistry
  readonly #config: SchedulerConfig
  readonly #logger: Logger
  readonly #workers = new Set<Promise<void>>()

  public constructor(
    repository: PendingTaskRepository,
    pipeline: ScheduledTaskPipeline,
    lockRegistry: ScheduledTaskLockRegistry,
    config: SchedulerConfig,
    logger: Logger
  ) {
    validateConfig(config)
    this.#repository = repository
    this.#pipeline = pipeline
    this.#lockRegistry = lockRegistry
    this.#config = config
    this.#logger = logger
  }

  /**
   * 单次扫描：取一批到期任务并逐个启动 worker。
   * 到达并发上限时直接"让出"（不排队），等待下一次 scanOnce 驱动的扫描；扫描失败只记录
   * 不抛出——上层以定时驱动重扫，异常上抛只会打断无状态的轮询节奏。
   */
  public async scanOnce(signal: AbortSignal): Promise<void> {
    let tasks: readonly AgentTaskDefinition[]
    try {
      tasks = await this.#repository.getPendingTasks(new Date(), this.#config.batchSize, signal)
      signal.throwIfAborted()
    } catch (cause: unknown) {
      if (!signal.aborted) {
        this.#logger.error('scheduler scan failed', { error: normalizeError(cause) })
      }
      return
    }
    if (tasks.length === 0) return
    this.#logger.info('scheduler found pending tasks', { count: tasks.length })
    for (const task of tasks) {
      if (this.#workers.size >= this.#config.maxConcurrent) {
        this.#logger.debug('scheduler concurrency limit reached', {
          max_concurrent: this.#config.maxConcurrent,
          deferred_tasks: tasks.length,
        })
        return
      }
      this.#startWorker(task, signal)
    }
  }

  /**
   * 执行单个任务：先认领 lease，再运行 pipeline。
   * 执行受三重信号约束——父级取消、执行超时预算、lease 丢失；任一触发都会中断运行。
   * lock 冲突（其他实例已认领）按正常情况记录，不算失败；lease 释放失败只告警不致命。
   */
  public async executeTask(task: AgentTaskDefinition, parent: AbortSignal): Promise<void> {
    // ── 信号组装：超时预算并入任务信号，任务级 logger 带上 task_id ──
    const timeoutController = new AbortController()
    const timeout = setTimeout((): void => {
      timeoutController.abort(new Error('定时任务执行超时'))
    }, this.#config.executionTimeoutMilliseconds)
    timeout.unref()
    const taskSignal = AbortSignal.any([parent, timeoutController.signal])
    const logger = this.#logger.child({ task_id: task.taskId })
    let lease: ScheduledTaskLease | undefined
    try {
      // ── 认领：tryAcquire 失败即抛 LOCK_CONFLICT；lease.lost 必须中断执行 ──
      // 否则 fencing 语义被破坏：lease 已被他人接管的实例继续写会造成双重执行。
      lease = await this.#lockRegistry.tryAcquire(task.taskId, LOCK_OWNER, taskSignal)
      const leaseController = new AbortController()
      observeLeaseLoss(lease, leaseController)
      const runSignal = AbortSignal.any([taskSignal, leaseController.signal])
      logger.info('scheduled task started')
      // ── 执行：运行期信号已被中断时，结果不可信，按失败处理 ──
      await this.#pipeline(task.taskId, lease, runSignal)
      if (runSignal.aborted) throw normalizeError(runSignal.reason)
      logger.info('scheduled task completed')
    } catch (cause: unknown) {
      if (isLockConflict(cause)) {
        logger.debug('scheduled task lock conflict')
      } else {
        logger.error('scheduled task failed', { error: normalizeError(cause) })
      }
    } finally {
      // ── 收尾：任何路径都必须归还 lease，否则任务会一直处于认领状态 ──
      clearTimeout(timeout)
      if (lease !== undefined) {
        try {
          await lease.release()
        } catch (cause: unknown) {
          logger.warn('scheduled task lock release failed', { error: normalizeError(cause) })
        }
      }
    }
  }

  /** 停机排空：等待全部 worker 结束，超过有界时长后放弃并告警。 */
  public async waitForIdle(): Promise<void> {
    if (this.#workers.size === 0) return
    const workers = Promise.allSettled([...this.#workers])
    const timeout = waitUninterruptibly(WORKER_DRAIN_TIMEOUT_MILLISECONDS)
    const result = await Promise.race([workers.then((): 'done' => 'done'), timeout])
    if (result === 'timeout') this.#logger.warn('scheduler worker shutdown timed out')
  }

  /** fire-and-forget 启动 worker：登记进集合以便停机排空，结束时自动清理。 */
  #startWorker(task: AgentTaskDefinition, signal: AbortSignal): void {
    const worker = this.executeTask(task, signal)
    this.#workers.add(worker)
    void worker.finally((): void => {
      this.#workers.delete(worker)
    })
  }
}

function validateConfig(config: SchedulerConfig): void {
  positiveInteger(config.executionTimeoutMilliseconds, '任务超时')
  positiveInteger(config.batchSize, '任务批量上限')
  positiveInteger(config.maxConcurrent, '任务并发上限')
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须大于 0`)
}

/** 监听 lease 丢失并把原因转化为运行中断：lease 被接管意味着本实例的写入资格已失效。 */
function observeLeaseLoss(lease: ScheduledTaskLease, controller: AbortController): void {
  if (lease.lost === undefined) return
  void lease.lost.then(
    (error: Error): void => controller.abort(error),
    (cause: unknown): void => controller.abort(normalizeError(cause))
  )
}

/** 区分"另一个实例已认领"与真实失败：前者是正常竞争，后者才需要告警。 */
function isLockConflict(value: unknown): boolean {
  return value instanceof RegistryError && value.code === REGISTRY_ERROR_CODES.LOCK_CONFLICT
}

function waitUninterruptibly(milliseconds: number): Promise<'timeout'> {
  return new Promise<'timeout'>((resolve) => {
    const timeout = setTimeout((): void => resolve('timeout'), milliseconds)
    timeout.unref()
  })
}
