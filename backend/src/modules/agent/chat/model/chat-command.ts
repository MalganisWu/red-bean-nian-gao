import type { ChatMessage, StartEvent } from '../../run/model/agent-run.js'
import type { ChatRunHandle } from '../stream/chat-run-handle.js'

/** Chat 请求共有的认证与链路上下文，由 HTTP 边界提供。 */
export interface ChatRequestContext {
  readonly userId: string
  readonly traceId: string
  readonly signal: AbortSignal
}

/** 发起新对话或续聊所需的业务输入。 */
export interface StartChatCommand extends ChatRequestContext {
  readonly sessionId?: string | undefined
  readonly agentId?: string | undefined
  readonly messages: readonly ChatMessage[]
}

/** 回答人工交互卡片所需的业务输入。 */
export interface AnswerChatCommand extends ChatRequestContext {
  readonly sessionId: string
  readonly agentId?: string | undefined
  readonly interactionId: string
  readonly answers?: Readonly<Record<string, unknown>> | undefined
  readonly refused?: boolean | undefined
}

/** 取消当前用户运行所需的业务输入。 */
export interface CancelChatCommand {
  readonly userId: string
  readonly requestId: string
}

/** Chat 用例返回给传输层的流及其首帧元数据。 */
export interface StartedChatRun {
  readonly start: StartEvent
  readonly handle: ChatRunHandle
}
