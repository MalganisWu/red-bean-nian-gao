/** Task 投递队列的持久化边界；默认实现为 `RedisDeliveryQueueStore`，由 `task.module.ts` 组装。 */
export interface DeliveryQueueStore {
  rightPush(key: string, value: string, signal: AbortSignal): Promise<void>
  list(key: string, signal: AbortSignal): Promise<readonly string[]>
  claim(sourceKey: string, processingKey: string, signal: AbortSignal): Promise<string | undefined>
  requeue(
    sourceKey: string,
    processingKey: string,
    entry: string,
    signal: AbortSignal
  ): Promise<void>
  recover(sourceKey: string, processingKey: string, signal: AbortSignal): Promise<void>
  remove(processingKey: string, entry: string, signal: AbortSignal): Promise<void>
}

/** 投递期间持有的 Session 租约；调用方始终负责释放。 */
export interface DeliveryLease {
  readonly fencingToken?: bigint | undefined
  release(): void | Promise<void>
}

/**
 * Task 投递使用的 Session 锁边界。
 * 默认实现为 Agent Module 的 `RedisSessionLockRegistry`，经 `composition-root.ts` 注入；
 * 锁冲突表示稍后重试，调用方拥有成功取得的 lease。
 */
export interface DeliveryLockRegistry {
  tryAcquire(
    sessionId: string,
    owner: string,
    signal?: AbortSignal
  ): DeliveryLease | Promise<DeliveryLease>
}
