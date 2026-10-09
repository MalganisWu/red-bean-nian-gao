import type { AgentMessage } from '../../../model/agent-message.js'

/** Session 恢复日志代；同 revision 共享内容，writeProof 用于原子拒绝失租 owner。 */
export interface MessageBufferGeneration {
  readonly revision: bigint
  readonly writeProof?: string | undefined
}

/**
 * Agent Module 的故障恢复消息缓冲边界。
 * 默认实现为 RedisMessageBuffer，由 agent.module.ts 组装；flush 具有消费语义。
 */
export interface MessageBuffer {
  append(sessionId: string, message: AgentMessage, signal: AbortSignal): Promise<void>
  peek(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]>
  flush(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]>
  clear(sessionId: string, signal: AbortSignal): Promise<void>
  /** 主 Session 按持久化 revision 分代写入，旧代清理失败也不会污染下一轮恢复。 */
  appendGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void>
  peekGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]>
  clearGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<void>
}
