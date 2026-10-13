import type { AgentMessage } from '../../../model/agent-message.js'
import type { AgentRunPreparation } from '../../../loader/port/agent-loader.port.js'
import type { RuntimeStateAppender } from '../../../execution/port/runtime-state-appender.js'
import { serializeAgentMessage } from '../../../serialization/agent-message-serializer.js'
import { validateAndFix } from '../../../session/service/ask-card.js'
import { SUB_EXECUTION_STATUSES, type SubExecutionRecord } from '../../model/sub-execution.js'
import type { SubExecutionRepository } from '../../repository/port/sub-execution-repository.port.js'

/**
 * 提问工具名；恢复时据此识别滞留子执行里悬挂的提问调用，必须与 `AskUserTool.name` 保持一致。
 */
const ASK_USER_TOOL_NAME = 'sys_ask_user'

/** 在主 Agent 运行前收束滞留的 pending 子执行；单项失败不会阻断其余恢复。 */
export class SubExecutionRecovery implements AgentRunPreparation {
  /** 子执行仓储；认领 pending 记录并以 CAS 写回收束结果。 */
  readonly #repository: SubExecutionRepository
  /** 运行时状态追加器；把补齐后的消息并入子执行的 runtimeState。 */
  readonly #runtimeState: RuntimeStateAppender

  public constructor(repository: SubExecutionRepository, runtimeState: RuntimeStateAppender) {
    this.#repository = repository
    this.#runtimeState = runtimeState
  }

  /**
   * 收束会话内滞留的 pending 子执行：逐个认领并改写为中断 / 等待用户态。
   * 每轮开头先 `throwIfAborted` 让取消即时生效，单项失败也不阻断其余子执行的恢复。
   *
   * @param sessionId - 目标会话；空串直接跳过（无匹配范围）
   * @param signal - 中止信号；已中止或单项失败后均会复检
   */
  public async prepare(sessionId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (sessionId === '') return
    const pending = await this.#repository.listPending(sessionId, signal)
    for (const record of pending) {
      try {
        await this.#recoverOne(record, signal)
      } catch {
        signal.throwIfAborted()
        // 每个子执行独立尽力恢复；单项失败不能阻断其余 pending 工作。
      }
    }
  }

  /**
   * 收束单条滞留子执行：先原子认领，再把恢复缓冲补齐成中断 / 等待用户态并写回。
   * 认领会递增 revision，从而让仍在别处运行的旧 owner 追加恢复日志失败。
   *
   * @param record - 待收束的 pending 记录快照，其 revision 作为认领基准。
   * @param signal - 中止信号，透传到仓储读写。
   */
  async #recoverOne(record: SubExecutionRecord, signal: AbortSignal): Promise<void> {
    const claimed = await this.#repository.claimPending(record.executionId, record.revision, signal)
    const buffered = claimed.recoveryMessages
    const interruptId = danglingInterruptCallId(buffered, ASK_USER_TOOL_NAME)
    const messages = validateAndFix(buffered, interruptId)
    const now = new Date()
    claimed.status =
      interruptId === '' ? SUB_EXECUTION_STATUSES.INTERRUPTED : SUB_EXECUTION_STATUSES.AWAITING_USER
    claimed.pendingInterruptId = interruptId === '' ? undefined : interruptId
    claimed.runtimeState = this.#runtimeState.appendMessages(claimed.runtimeState, messages)
    claimed.recoveryMessages = []
    claimed.display = messages.map(serializeAgentMessage)
    claimed.updatedAt = now
    claimed.completedAt = now
    await this.#repository.update(claimed, signal)
  }
}

/**
 * 找子执行残留消息里悬挂的提问调用：有 tool call 无对应 tool result 的调用即悬挂。
 * 从后往前取第一个未闭合的调用，供恢复时按卡片语义校验与修补。
 *
 * @param messages - 子执行残留在恢复缓冲里的消息。
 * @param toolName - 目标工具名，通常是提问工具。
 * @returns 悬挂调用的 call id；没有悬挂调用时返回空串。
 */
function danglingInterruptCallId(messages: readonly AgentMessage[], toolName: string): string {
  const completed = new Set(
    messages
      .filter((message): boolean => message.role === 'tool' && message.toolCallId !== undefined)
      .map((message): string => message.toolCallId ?? '')
  )
  for (const message of messages.toReversed()) {
    for (const call of (message.toolCalls ?? []).toReversed()) {
      if (call.function.name === toolName && !completed.has(call.id)) return call.id
    }
  }
  return ''
}
