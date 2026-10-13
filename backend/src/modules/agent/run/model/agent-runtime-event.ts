import type { AgentJsonObject } from '../../model/json-value.js'

/** 产品侧 Runtime 事件的类型标签；同时作为可辨识联合的判别字段。 */
export const AGENT_EVENT_TYPES = Object.freeze({
  TOKEN: 'token',
  STATUS: 'status',
  TOOL_START: 'tool_start',
  TOOL_RESULT: 'tool_result',
  REASON: 'reason',
  COMPACTION: 'compaction',
} as const)

/** status 事件的机器码；文案由展示层映射（见 `chat-event-presenter.ts`）而非在此拼装。 */
export const AGENT_STATUS_CODES = Object.freeze({
  THINKING: 'thinking',
  ANALYZING_RESULTS: 'analyzing_results',
  LLM_RETRY: 'llm_retry',
  LLM_EMPTY_RESPONSE_RETRY: 'llm_empty_response_retry',
} as const)

/** status 码的字面量联合。 */
export type AgentStatusCode = (typeof AGENT_STATUS_CODES)[keyof typeof AGENT_STATUS_CODES]

/** 模型正文增量。 */
export interface AgentTokenEvent {
  /** 判别字段，固定为 `token`。 */
  readonly type: 'token'
  /** 模型输出的正文增量。 */
  readonly content: string
}

/** 生命周期状态；`attempt`/`maxAttempts` 只在重试类状态码上有意义。 */
export interface AgentStatusEvent {
  /** 判别字段，固定为 `status`。 */
  readonly type: 'status'
  /** 状态码；Runtime 播报了本层未登记的状态时缺省。 */
  readonly code?: AgentStatusCode | undefined
  /** 当前重试序号；仅重试类状态码有意义。 */
  readonly attempt?: number | undefined
  /** 最大重试次数；仅重试类状态码有意义。 */
  readonly maxAttempts?: number | undefined
}

/** 工具开始执行的播报；`params` 为 `null` 表示这次调用的参数不是可解析的 JSON 对象。 */
export interface AgentToolStartEvent {
  /** 判别字段，固定为 `tool_start`。 */
  readonly type: 'tool_start'
  /** 工具名。 */
  readonly toolName: string
  /** 工具调用 ID，与结果事件配对。 */
  readonly callId: string
  /** 调用参数；不可解析为 JSON 对象时为 null。 */
  readonly params: AgentJsonObject | null
}

/** 工具执行结果；`error` 有值即表示这次调用失败，展示层应据此把结果标记为失败态。 */
export interface AgentToolResultEvent {
  /** 判别字段，固定为 `tool_result`。 */
  readonly type: 'tool_result'
  /** 工具名。 */
  readonly toolName: string
  /** 工具调用 ID，与开始事件配对。 */
  readonly callId: string
  /** 工具结果文本。 */
  readonly content: string
  /** 失败原因；有值即表示本次调用失败。 */
  readonly error?: string | undefined
}

/** 推理摘要播报（与正文 `token` 事件区分开）；`step` 是本轮内的工具迭代序号。 */
export interface AgentReasonEvent {
  /** 判别字段，固定为 `reason`。 */
  readonly type: 'reason'
  /** 推理摘要文本。 */
  readonly content: string
  /** 本轮内的工具迭代序号。 */
  readonly step: number
  /** 播报时刻（epoch 毫秒）。 */
  readonly timestamp: number
}

/** 上下文压缩事件的播报；token 数为估算值，只用于展示压缩量级，不参与任何判定。 */
export interface AgentCompactionEvent {
  /** 判别字段，固定为 `compaction`。 */
  readonly type: 'compaction'
  /** 触发来源（auto / manual）。 */
  readonly trigger: 'auto' | 'manual'
  /** 压缩前上下文 token 估算量。 */
  readonly preTokens: number
  /** 压缩后上下文 token 估算量。 */
  readonly postTokens: number
  /** 被总结的消息条数。 */
  readonly messagesSummarized: number
}

/** Runtime 事件进入产品域后的稳定防腐模型。 */
export type AgentRuntimeEvent =
  | AgentCompactionEvent
  | AgentReasonEvent
  | AgentStatusEvent
  | AgentTokenEvent
  | AgentToolResultEvent
  | AgentToolStartEvent
