import type { AgentMessage } from '../../model/agent-message.js'
import type { StoredRuntimeState } from '../model/runtime-state.js'

/**
 * 向不透明 Runtime 状态追加已确认消息。
 * 默认实现为 `RuntimeStateCodec`，由 `agent.module.ts` 组装；业务 Service 不理解 SDK Checkpoint。
 */
export interface RuntimeStateAppender {
  /**
   * 把已确认消息追加进状态信封，保留 checkpoint 的其余字段。
   * 无既有状态时会造一个最小信封，让「首次运行尚无快照」也能落地；空消息数组不触发
   * 无谓的重新序列化，原样返回入参。
   *
   * @param state - 既有状态信封；undefined 表示本次运行尚无快照。
   * @param messages - 待追加的产品消息，按时间顺序排列；为空时原样返回 state。
   * @returns 追加后的信封；无可追加消息时原样返回入参，可能为 undefined。
   */
  appendMessages(
    state: StoredRuntimeState | undefined,
    messages: readonly AgentMessage[]
  ): StoredRuntimeState | undefined
}
