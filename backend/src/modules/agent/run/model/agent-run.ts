import type { AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent, AgentStatusEvent } from './agent-runtime-event.js'
import type { AnswerMarker } from '../../session/model/session.js'

/** 应用层聊天消息，不携带 HTTP 字段命名约定。 */
export interface ChatMessage {
  readonly role: 'assistant' | 'user'
  readonly content: string
}

/** 一次 Agent 运行的统一业务身份；宿主不得再用 request/thread 等技术字段代替其语义。 */
export interface AgentRunIdentity {
  readonly runId: string
  readonly sessionId: string
  readonly userId: string
  readonly traceId: string
  readonly parentRunId?: string | undefined
  readonly attempt?: number | undefined
}

/** 流式事件类型成员引用源：case 标签与比较统一走本常量（保持 IDE 导航可跳、防拼写漂移）。 */
export const STREAM_EVENT_TYPES = Object.freeze({
  START: 'start',
  STATUS: 'status',
  CARD: 'card',
  DONE: 'done',
  ERROR: 'error',
  HEARTBEAT: 'heartbeat',
  AGENT_EVENT: 'agent_event',
} as const)

export interface StartEvent {
  readonly type: 'start'
  readonly requestId: string
  readonly sessionId: string
  readonly traceId: string
}

export interface LocalizedStatusEvent {
  readonly type: 'status'
  readonly code?: AgentStatusEvent['code']
  readonly attempt?: number
  readonly maxAttempts?: number
  readonly content: string
}

export interface CardEvent {
  readonly type: 'card'
  readonly interactionId: string
  readonly status: string
  readonly questions: AgentJsonValue
}

export interface DoneEvent {
  readonly type: 'done'
  readonly tokensUsed: number
  readonly sessionId: string
}

export interface StreamErrorEvent {
  readonly type: 'error'
  readonly code: number
  readonly message: string
}

export interface HeartbeatEvent {
  readonly type: 'heartbeat'
  readonly timestamp: number
}

export interface SubAgentEnvelope {
  readonly type: 'agent_event'
  readonly agentId: string
  readonly agentName: string
  readonly executionId: string
  readonly parentCallId: string
  readonly eventType: string
  readonly event: ProductStreamEvent
}

export type ProductStreamEvent =
  | CardEvent
  | DoneEvent
  | HeartbeatEvent
  | LocalizedStatusEvent
  | AgentRuntimeEvent
  | StartEvent
  | StreamErrorEvent
  | SubAgentEnvelope

/** Controller 调用聊天 Application Service 时使用的中性请求。 */
export interface AgentRunRequest extends AgentRunIdentity {
  readonly agentId: string
  readonly messages: readonly ChatMessage[]
  readonly answer?: AnswerMarker
}
