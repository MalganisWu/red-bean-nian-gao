/** Task 投递队列的持久化边界；默认实现为 `RedisDeliveryQueueStore`，由 `task.module.ts` 组装。 */
export interface DeliveryQueueStore {
  /**
   * 把条目追加到待办列表尾部，先入先出。
   *
   * @param key - 目标列表的存储键。
   * @param value - 待追加的条目内容，对存储层不透明。
   * @param signal - 取消信号，透传到存储后端。
   */
  rightPush(key: string, value: string, signal: AbortSignal): Promise<void>

  /**
   * 读取列表全部条目，供对账时判断哪些执行已在队列里。
   *
   * @param key - 目标列表的存储键。
   * @param signal - 取消信号，透传到存储后端。
   * @returns 列表内的全部条目，顺序与写入一致。
   */
  list(key: string, signal: AbortSignal): Promise<readonly string[]>

  /**
   * 原子地把一条待办移到处理中列表并返回，保证「取出即不再被别人取到」。
   *
   * @param sourceKey - 待办列表键，从头部取。
   * @param processingKey - 处理中列表键，取出的条目移入此处。
   * @param signal - 取消信号，透传到存储后端。
   * @returns 认领到的条目；待办为空时返回 `undefined`。
   */
  claim(sourceKey: string, processingKey: string, signal: AbortSignal): Promise<string | undefined>

  /**
   * 投递失败时把条目从处理中放回待办，与 `claim` 互为逆操作；两步顺序不能反。
   *
   * @param sourceKey - 待办列表键，条目放回这里。
   * @param processingKey - 处理中列表键，条目从这里移出。
   * @param entry - 要放回的条目，须与 `claim` 返回的一致。
   * @param signal - 取消信号，透传到存储后端。
   */
  requeue(
    sourceKey: string,
    processingKey: string,
    entry: string,
    signal: AbortSignal
  ): Promise<void>

  /**
   * 崩溃恢复：把上次崩溃滞留在处理中列表的条目整体搬回待办，排空前必调。
   *
   * @param sourceKey - 待办列表键。
   * @param processingKey - 处理中列表键，其中的残留条目会被搬空。
   * @param signal - 取消信号，透传到存储后端。
   */
  recover(sourceKey: string, processingKey: string, signal: AbortSignal): Promise<void>

  /**
   * 投递成功后从处理中列表摘除条目；摘除前的重复投递由投递确认标记兜底。
   *
   * @param processingKey - 处理中列表键。
   * @param entry - 要摘除的条目。
   * @param signal - 取消信号，透传到存储后端。
   */
  remove(processingKey: string, entry: string, signal: AbortSignal): Promise<void>
}

/** 投递期间持有的 Session 租约；调用方始终负责释放。 */
export interface DeliveryLease {
  /** 租约围栏令牌；透传给下游写入，供其拒绝过期租约的写入。 */
  readonly fencingToken?: bigint | undefined
  /** 释放租约；成功或失败都必须调用，否则会话锁不会归还。 */
  release(): void | Promise<void>
}

/**
 * Task 投递使用的 Session 锁边界。
 * 默认实现为 Agent Module 的 `RedisSessionLockRegistry`，经 `composition-root.ts` 注入；
 * 锁冲突表示稍后重试，调用方拥有成功取得的 lease。
 */
export interface DeliveryLockRegistry {
  /**
   * 尝试取得指定会话的投递锁；锁冲突由实现以错误表示，调用方据此让位而非重试。
   *
   * @param sessionId - 目标会话，作为锁的竞争键。
   * @param owner - 锁持有者标识，写入锁值用于诊断。
   * @param signal - 可选的取消信号，透传到锁后端。
   * @returns 取得的租约，由调用方负责释放。
   */
  tryAcquire(
    sessionId: string,
    owner: string,
    signal?: AbortSignal
  ): DeliveryLease | Promise<DeliveryLease>
}
