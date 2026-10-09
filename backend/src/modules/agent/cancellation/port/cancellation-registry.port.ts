/**
 * Chat Application Service 使用的跨实例取消能力。
 * 默认实现为 `RedisCancelRegistry`，由 `agent.module.ts` 绑定到 `DefaultChatService`。
 * `wrap` 返回组合信号，`deregister` 只能在运行 finalization 完成后调用。
 */
export interface CancelRegistryPort {
  wrap(parent: AbortSignal, key: string): AbortSignal | Promise<AbortSignal>
  cancel(key: string): boolean | Promise<boolean>
  deregister(key: string): void | Promise<void>
}
