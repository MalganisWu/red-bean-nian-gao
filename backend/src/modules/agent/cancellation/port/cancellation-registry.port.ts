/**
 * Chat Application Service 使用的跨实例取消能力。
 * 默认实现为 `RedisCancelRegistry`，由 `agent.module.ts` 绑定到 `DefaultChatService`。
 * `wrap` 返回组合信号，`deregister` 只能在运行 finalization 完成后调用。
 */
export interface CancelRegistryPort {
  /**
   * 为一次请求建立可取消的信号并登记到跨实例注册表；同 key 重复登记必须报错，否则会覆盖前一份登记。
   *
   * @param parent 上游取消信号；其 abort 级联到本请求，无上游时传一个不会中止的信号。
   * @param key 取消键；同一用户与运行内唯一，注册与注销共用同一算法。
   * @returns 本次请求的取消信号，本地取消与跨实例取消都汇聚到它。
   */
  wrap(parent: AbortSignal, key: string): AbortSignal | Promise<AbortSignal>
  /**
   * 取消一次请求；语义是幂等的「尽力投递」，目标已结束也不算失败。
   *
   * @param key 待取消的取消键。
   * @returns 是否命中：`false` 表示该 key 不存在（可能已结束或被回收）；已被取消返回 `true`。
   */
  cancel(key: string): boolean | Promise<boolean>
  /**
   * 请求收尾时注销登记；只能在运行 finalization 完成后调用，避免与在途取消竞态。
   *
   * @param key 待注销的取消键。
   */
  deregister(key: string): void | Promise<void>
}
