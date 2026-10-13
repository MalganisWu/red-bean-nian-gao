import type { AgentMessage } from '../../../model/agent-message.js'

/** Session 恢复日志代；同 revision 共享内容，writeProof 用于原子拒绝失租 owner。 */
export interface MessageBufferGeneration {
  /** 持久化 revision；同 revision 共享一份内容，跨代写入互不干扰。 */
  readonly revision: bigint
  /** 写入所有权证明；Redis 实现据此原子拒绝已失租的旧 owner 写入。 */
  readonly writeProof?: string | undefined
}

/**
 * Agent Module 的故障恢复消息缓冲边界。
 * 默认实现为 RedisMessageBuffer，由 agent.module.ts 组装；flush 具有消费语义。
 */
export interface MessageBuffer {
  /**
   * 追加一条增量消息；只写不消费，供崩溃恢复时回放未提交部分。
   *
   * @param sessionId - 目标会话标识。
   * @param message - 待追加的增量消息；按写入顺序排列。
   * @param signal - 中止信号；取消后写入不应再落库。
   */
  append(sessionId: string, message: AgentMessage, signal: AbortSignal): Promise<void>
  /**
   * 读取缓冲中的全部增量消息但不消费；恢复流程用它和 checkpoint 拼接。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 中止信号；取消后放弃读取。
   * @returns 当前缓冲里的增量消息；缓冲为空时为空数组。
   */
  peek(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]>
  /**
   * 取出并清空缓冲；具有消费语义，读完即删，避免同一条消息被重复恢复。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 中止信号；取消后放弃本次消费。
   * @returns 本次取出的增量消息；删除失败时应让调用方感知，而不是静默重复。
   */
  flush(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]>
  /**
   * 清空缓冲而不取内容；用于会话正常结束后的清理。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 中止信号；取消后放弃清理。
   */
  clear(sessionId: string, signal: AbortSignal): Promise<void>
  /**
   * 主 Session 按持久化 revision 分代写入，旧代清理失败也不会污染下一轮恢复。
   *
   * @param sessionId - 目标会话标识。
   * @param generation - 目标代，含 revision 与写入所有权证明。
   * @param message - 待追加的增量消息。
   * @param signal - 中止信号；取消后写入不应再落库。
   */
  appendGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void>
  /**
   * 读取指定代的增量消息但不消费；writeProof 不匹配的旧代内容不可见。
   *
   * @param sessionId - 目标会话标识。
   * @param generation - 目标代，含 revision 与写入所有权证明。
   * @param signal - 中止信号；取消后放弃读取。
   * @returns 该代的增量消息；该代不存在或已失租时为空数组。
   */
  peekGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]>
  /**
   * 清空指定代的缓冲；只清理这一代，不影响已提交或后续代的恢复。
   *
   * @param sessionId - 目标会话标识。
   * @param generation - 目标代，含 revision 与写入所有权证明。
   * @param signal - 中止信号；取消后放弃清理。
   */
  clearGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<void>
}
