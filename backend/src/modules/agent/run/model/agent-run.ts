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

/** 流已建立的首帧；在此之前客户端拿不到任何其它事件，SSE 断线重连也以此为锚点。 */
export interface StartEvent {
  readonly type: 'start'
  readonly requestId: string
  readonly sessionId: string
  readonly traceId: string
}

/**
 * 面向客户端的 status 事件：保留 `code` 供前端分支，同时带已本地化的 `content`。
 * `code` 允许缺省是因为 Runtime 可能播报本层尚未登记的状态，此时只能给文案。
 */
export interface LocalizedStatusEvent {
  readonly type: 'status'
  readonly code?: AgentStatusEvent['code']
  readonly attempt?: number
  readonly maxAttempts?: number
  readonly content: string
}

/** 交互卡片事件：把工具的中断载荷渲染成待用户作答的表单；`status` 标出卡片当前处于哪个阶段。 */
export interface CardEvent {
  readonly type: 'card'
  readonly interactionId: string
  readonly status: string
  readonly questions: AgentJsonValue
}

/** 正常运行结束的终止帧；出现它就不再期待任何后续事件。 */
export interface DoneEvent {
  readonly type: 'done'
  readonly tokensUsed: number
  readonly sessionId: string
}

/** 失败终止帧；与 `done` 互斥，二者必有其一作为流的收尾。 */
export interface StreamErrorEvent {
  readonly type: 'error'
  readonly code: number
  readonly message: string
}

/** 保活帧：长时间无业务事件时由服务端补齐，防止中间层按空闲超时掐断连接。 */
export interface HeartbeatEvent {
  readonly type: 'heartbeat'
  readonly timestamp: number
}

/**
 * 子 Agent 事件的外层信封：把子运行的流事件原样嵌进父流，并补上「是谁产生的」。
 * 客户端因此只需一套流解析逻辑——剥掉信封后，`event` 与父级事件同构。
 */
export interface SubAgentEnvelope {
  readonly type: 'agent_event'
  readonly agentId: string
  readonly agentName: string
  readonly executionId: string
  readonly parentCallId: string
  readonly eventType: string
  readonly event: ProductStreamEvent
}

/** 客户端实际收到的流事件全集；`agent_event` 之外的成员都来自产品层自身。 */
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
