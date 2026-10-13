import type { AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent, AgentStatusEvent } from './agent-runtime-event.js'
import type { AnswerMarker } from '../../session/model/session.js'

/** 应用层聊天消息，不携带 HTTP 字段命名约定。 */
export interface ChatMessage {
  /** 消息角色；只有 user 与 assistant 两种（工具消息不在此模型内）。 */
  readonly role: 'assistant' | 'user'
  /** 消息正文文本。 */
  readonly content: string
}

/** 一次 Agent 运行的统一业务身份；宿主不得再用 request/thread 等技术字段代替其语义。 */
export interface AgentRunIdentity {
  /** 本次运行的唯一 ID；run 内所有事件与事实共享同一值。 */
  readonly runId: string
  /** 所属会话 ID。 */
  readonly sessionId: string
  /** 发起运行的用户 ID。 */
  readonly userId: string
  /** 链路追踪 ID，用于串联上下游日志。 */
  readonly traceId: string
  /** 父运行 ID；子 Agent 运行才有值，顶层运行为 undefined。 */
  readonly parentRunId?: string | undefined
  /** 同一逻辑运行的重试序号；未重试时不写。 */
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
  /** 判别字段，固定为 `start`。 */
  readonly type: 'start'
  /** 客户端发起请求时给的请求 ID，用于对账。 */
  readonly requestId: string
  /** 所属会话 ID。 */
  readonly sessionId: string
  /** 链路追踪 ID。 */
  readonly traceId: string
}

/**
 * 面向客户端的 status 事件：保留 `code` 供前端分支，同时带已本地化的 `content`。
 * `code` 允许缺省是因为 Runtime 可能播报本层尚未登记的状态，此时只能给文案。
 */
export interface LocalizedStatusEvent {
  /** 判别字段，固定为 `status`。 */
  readonly type: 'status'
  /** 状态码，供前端分支；Runtime 播报了本层未登记的状态时缺省。 */
  readonly code?: AgentStatusEvent['code']
  /** 当前重试序号；仅重试类状态码有意义。 */
  readonly attempt?: number
  /** 最大重试次数；仅重试类状态码有意义。 */
  readonly maxAttempts?: number
  /** 已本地化的展示文案。 */
  readonly content: string
}

/** 交互卡片事件：把工具的中断载荷渲染成待用户作答的表单；`status` 标出卡片当前处于哪个阶段。 */
export interface CardEvent {
  /** 判别字段，固定为 `card`。 */
  readonly type: 'card'
  /** 交互 ID，取挂起工具的 toolCallId；用户作答时原样回传。 */
  readonly interactionId: string
  /** 卡片当前所处阶段（如 pending）。 */
  readonly status: string
  /** 待用户作答的问题列表载荷。 */
  readonly questions: AgentJsonValue
}

/** 正常运行结束的终止帧；出现它就不再期待任何后续事件。 */
export interface DoneEvent {
  /** 判别字段，固定为 `done`。 */
  readonly type: 'done'
  /** 本轮消耗的 token 总数。 */
  readonly tokensUsed: number
  /** 所属会话 ID。 */
  readonly sessionId: string
}

/** 失败终止帧；与 `done` 互斥，二者必有其一作为流的收尾。 */
export interface StreamErrorEvent {
  /** 判别字段，固定为 `error`。 */
  readonly type: 'error'
  /** 错误码。 */
  readonly code: number
  /** 面向用户的错误消息。 */
  readonly message: string
}

/** 保活帧：长时间无业务事件时由服务端补齐，防止中间层按空闲超时掐断连接。 */
export interface HeartbeatEvent {
  /** 判别字段，固定为 `heartbeat`。 */
  readonly type: 'heartbeat'
  /** 保活帧生成时刻（epoch 毫秒）。 */
  readonly timestamp: number
}

/**
 * 子 Agent 事件的外层信封：把子运行的流事件原样嵌进父流，并补上「是谁产生的」。
 * 客户端因此只需一套流解析逻辑——剥掉信封后，`event` 与父级事件同构。
 */
export interface SubAgentEnvelope {
  /** 判别字段，固定为 `agent_event`。 */
  readonly type: 'agent_event'
  /** 产出事件的子 Agent ID。 */
  readonly agentId: string
  /** 子 Agent 展示名。 */
  readonly agentName: string
  /** 子执行的 ID。 */
  readonly executionId: string
  /** 父运行里触发该子执行的工具调用 ID。 */
  readonly parentCallId: string
  /** 内层事件的类型标签，供客户端分流。 */
  readonly eventType: string
  /** 子运行产生的原始流事件。 */
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
  /** 要运行的 Agent ID。 */
  readonly agentId: string
  /** 本次请求携带的会话消息。 */
  readonly messages: readonly ChatMessage[]
  /** 用户对上一张交互卡片的作答标记；无作答时不写。 */
  readonly answer?: AnswerMarker
}
