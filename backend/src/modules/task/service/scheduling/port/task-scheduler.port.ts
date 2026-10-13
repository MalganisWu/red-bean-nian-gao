import type { AgentTaskDefinition } from './../../../model/task.js'

/** 扫描配置；来自 `config.scheduledTask`，在组装期一次性传入，运行期不再读配置。 */
export interface SchedulerConfig {
  /** 单轮扫描最多取回的任务数；批量过大会拉长单轮耗时。 */
  readonly batchSize: number
  /** 同时运行的任务上限；到达上限后本轮直接让出，不排队。 */
  readonly maxConcurrent: number
  /** 单次执行的超时预算（毫秒）；到点中止本次执行并按失败处理。 */
  readonly executionTimeoutMilliseconds: number
}

/**
 * Task Module 查询待调度任务的出站 Port。
 * 默认实现为 `PostgresTaskQueryRepository`，在 `task.module.ts` 组装；查询失败与取消原样向 Scheduler 传播。
 */
export interface PendingTaskRepository {
  /**
   * 取一批到期且活跃的任务，按 next_run_at 升序，供调度器单轮扫描。
   *
   * @param now - 判定到期的当前时刻。
   * @param limit - 本批最大条数；非正数视为调用错误。
   * @param signal - 取消信号，透传到库查询。
   * @returns 到期任务定义列表；无到期任务时为空数组。
   */
  getPendingTasks(
    now: Date,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]>
}

/** 一次任务执行的分布式租约；`lost` 是失租信号，`release` 由持有者负责调用。 */
export interface ScheduledTaskLease {
  /** 租约围栏令牌；透传给持久化写入，供其拒绝更旧租约的落库。 */
  readonly fencingToken?: bigint | undefined
  /** 失租信号；兑现即表示租约被他人接管，持有者必须立即中断执行。 */
  readonly lost?: Promise<Error> | undefined
  /** 释放租约；无论执行成败都必须调用，否则任务会一直处于认领状态。 */
  release(): void | Promise<void>
}

/**
 * Task Module 自有的分布式执行锁边界。
 * 默认实现为 Agent Module 的 `RedisSessionLockRegistry`，并在 `composition-root.ts` 跨模块接入；
 * 调用方拥有 lease 的释放责任，失租通过 `lost` 信号传播。
 */
export interface ScheduledTaskLockRegistry {
  /**
   * 尝试认领某任务的执行锁；锁冲突由实现以错误表示，调用方按正常竞争处理而非告警。
   *
   * @param taskId - 目标任务，作为锁的竞争键。
   * @param owner - 锁持有者标识，写入锁值用于诊断。
   * @param signal - 可选的取消信号，透传到锁后端。
   * @returns 取得的租约，由调用方负责释放并监听其失租信号。
   */
  tryAcquire(
    taskId: string,
    owner: string,
    signal?: AbortSignal
  ): ScheduledTaskLease | Promise<ScheduledTaskLease>
}

/** 拿到租约后真正执行一次任务的函数；形状固定，便于组装期替换不同实现。 */
export type ScheduledTaskPipeline = (
  taskId: string,
  lease: ScheduledTaskLease,
  signal: AbortSignal
) => Promise<void>

/**
 * Task Module 的周期扫描与并发调度边界。
 * 默认实现为 `ScheduledTaskScheduler`，由 `task.module.ts` 注入扫描仓储、分布式锁和执行 Port。
 * `waitForIdle` 是应用停机边界，保证资源关闭前已发起任务完成 finalization。
 */
export interface TaskSchedulerPort {
  /**
   * 触发一轮扫描：取一批到期任务并按并发上限启动 worker，扫描异常只记录不上抛。
   *
   * @param signal - 取消信号，决定本轮扫描是否继续。
   */
  scanOnce(signal: AbortSignal): Promise<void>

  /**
   * 执行单个任务：先认领租约，再在受超时与失租约束的信号下运行 pipeline。
   *
   * @param task - 本次要执行的任务。
   * @param parent - 父级取消信号，与超时预算、失租信号合并后驱动本次执行。
   */
  executeTask(task: AgentTaskDefinition, parent: AbortSignal): Promise<void>

  /** 停机排空：等待全部在途 worker 结束，处理应用关闭前的 finalization。 */
  waitForIdle(): Promise<void>
}
