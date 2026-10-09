import type { AgentMessage } from '../../model/agent-message.js'
import type { StoredRuntimeState } from '../model/runtime-state.js'

/**
 * 向不透明 Runtime 状态追加已确认消息。
 * 默认实现为 `RuntimeStateCodec`，由 `agent.module.ts` 组装；业务 Service 不理解 SDK Checkpoint。
 */
export interface RuntimeStateAppender {
  appendMessages(
    state: StoredRuntimeState | undefined,
    messages: readonly AgentMessage[]
  ): StoredRuntimeState | undefined
}
