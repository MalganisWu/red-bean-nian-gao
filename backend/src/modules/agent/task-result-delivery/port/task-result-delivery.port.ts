/**
 * Agent 回合完成后投递外部任务结果的出站边界。
 *
 * Agent Module 拥有该 Port；Task Module 的默认实现为 `DeliveryQueue`，由 `task.module.ts` 创建，
 * 并在 `app/composition-root.ts` 注入 `agent.module.ts`。Task Module 拥有队列确认、重试与去重语义；
 * Agent 调用方只负责在进入新回合前请求排空，不得直接操作队列存储。
 */
export interface TaskResultDeliveryPort {
  drain(sessionId: string, signal: AbortSignal): Promise<void>
}
