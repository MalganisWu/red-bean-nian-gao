import type { AgentTaskDefinition } from './../../../model/task.js'

export interface SchedulerConfig {
  readonly batchSize: number
  readonly maxConcurrent: number
  readonly executionTimeoutMilliseconds: number
}

/**
 * Task Module 查询待调度任务的出站 Port。
 * 默认实现为 `PostgresTaskQueryRepository`，在 `task.module.ts` 组装；查询失败与取消原样向 Scheduler 传播。
 */
export interface PendingTaskRepository {
  getPendingTasks(
    now: Date,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]>
}

export interface ScheduledTaskLease {
  readonly fencingToken?: bigint | undefined
  readonly lost?: Promise<Error> | undefined
  release(): void | Promise<void>
}

/**
 * Task Module 自有的分布式执行锁边界。
 * 默认实现为 Agent Module 的 `RedisSessionLockRegistry`，并在 `composition-root.ts` 跨模块接入；
 * 调用方拥有 lease 的释放责任，失租通过 `lost` 信号传播。
 */
export interface ScheduledTaskLockRegistry {
  tryAcquire(
    taskId: string,
    owner: string,
    signal?: AbortSignal
  ): ScheduledTaskLease | Promise<ScheduledTaskLease>
}

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
  scanOnce(signal: AbortSignal): Promise<void>
  executeTask(task: AgentTaskDefinition, parent: AbortSignal): Promise<void>
  waitForIdle(): Promise<void>
}
