import type { AgentRunRequest } from '../model/agent-run.js'
import type { ChatRunHandle } from '../../chat/stream/chat-run-handle.js'

/**
 * Chat Application Service 调用的单次 Agent 运行边界。
 * 默认实现为 `ProductAgentRunService`，由 `agent.module.ts` 组装。
 * 返回的 `ChatRunHandle` 同时表达事件消费、主动取消与持久化 finalization 完成语义。
 */
export interface AgentRunServicePort {
  /**
   * 启动一次 Agent 运行，同步或异步返回可立即消费的 SSE 句柄。
   * 准备阶段在返回前完成（建句柄、加载 Agent 与会话状态），实际执行转入后台，
   * 失败一律经句柄从流内传播给消费者，不在此处抛出。
   *
   * @param request 本次运行的请求（runId / sessionId / userId 等）
   * @param signal 客户端中止信号；只约束准备与执行阶段，收尾段改用独立超时信号
   * @returns 承载本轮事件、可立即消费的 SSE 句柄
   */
  start(request: AgentRunRequest, signal: AbortSignal): ChatRunHandle | Promise<ChatRunHandle>
}
