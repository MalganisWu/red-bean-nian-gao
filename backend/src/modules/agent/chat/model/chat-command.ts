import type { ChatMessage, StartEvent } from '../../run/model/agent-run.js'
import type { ChatRunHandle } from '../stream/chat-run-handle.js'

/** Chat 请求共有的认证与链路上下文，由 HTTP 边界提供。 */
export interface ChatRequestContext {
  /** 当前登录用户标识；决定会话归属与取消作用域。 */
  readonly userId: string
  /** 链路追踪标识；透传到运行与日志，不参与业务分支。 */
  readonly traceId: string
  /** 客户端请求的中止信号；客户端断连时以此通知运行收尾。 */
  readonly signal: AbortSignal
}

/** 发起新对话或续聊所需的业务输入。 */
export interface StartChatCommand extends ChatRequestContext {
  /** 目标会话标识；缺省表示新建会话，由应用层生成。 */
  readonly sessionId?: string | undefined
  /** 目标 agent 标识；缺省由应用层补为默认 agent。 */
  readonly agentId?: string | undefined
  /** 客户端提交的消息列表；已有会话时必须有本轮 user 消息。 */
  readonly messages: readonly ChatMessage[]
}

/** 回答人工交互卡片所需的业务输入。 */
export interface AnswerChatCommand extends ChatRequestContext {
  /** 待回答的会话标识；必填。 */
  readonly sessionId: string
  /** 目标 agent 标识；缺省由应用层补为默认 agent。 */
  readonly agentId?: string | undefined
  /** 待回答的交互标识；与卡片上的 interaction_id 对应。 */
  readonly interactionId: string
  /** 用户提交的答案；缺省视为空对象。 */
  readonly answers?: Readonly<Record<string, unknown>> | undefined
  /** 用户是否拒绝作答；缺省视为否。 */
  readonly refused?: boolean | undefined
}

/** 取消当前用户运行所需的业务输入。 */
export interface CancelChatCommand {
  /** 发起取消的用户标识；与 requestId 共同定位取消键，避免跨用户误取消。 */
  readonly userId: string
  /** 待取消的运行标识（即首帧 start 事件里的 requestId）。 */
  readonly requestId: string
}

/** Chat 用例返回给传输层的流及其首帧元数据。 */
export interface StartedChatRun {
  /** 首帧 start 事件；承载 requestId/sessionId/traceId 元数据。 */
  readonly start: StartEvent
  /** 本次运行的事件句柄；传输层据此消费 SSE 帧并主动关闭。 */
  readonly handle: ChatRunHandle
}
