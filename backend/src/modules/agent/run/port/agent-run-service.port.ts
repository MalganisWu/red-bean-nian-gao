import type { AgentRunRequest } from '../model/agent-run.js'
import type { ChatRunHandle } from '../../chat/stream/chat-run-handle.js'

/**
 * Chat Application Service 调用的单次 Agent 运行边界。
 * 默认实现为 `ProductAgentRunService`，由 `agent.module.ts` 组装。
 * 返回的 `ChatRunHandle` 同时表达事件消费、主动取消与持久化 finalization 完成语义。
 */
export interface AgentRunServicePort {
  start(request: AgentRunRequest, signal: AbortSignal): ChatRunHandle | Promise<ChatRunHandle>
}
