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
  readonly type: 'token'
  readonly content: string
}

/** 生命周期状态；`attempt`/`maxAttempts` 只在重试类状态码上有意义。 */
export interface AgentStatusEvent {
  readonly type: 'status'
  readonly code?: AgentStatusCode | undefined
  readonly attempt?: number | undefined
  readonly maxAttempts?: number | undefined
}

/** 工具开始执行的播报；`params` 为 `null` 表示这次调用的参数不是可解析的 JSON 对象。 */
export interface AgentToolStartEvent {
  readonly type: 'tool_start'
  readonly toolName: string
  readonly callId: string
  readonly params: AgentJsonObject | null
}

/** 工具执行结果；`error` 有值即表示这次调用失败，展示层应据此把结果标记为失败态。 */
export interface AgentToolResultEvent {
  readonly type: 'tool_result'
  readonly toolName: string
  readonly callId: string
  readonly content: string
  readonly error?: string | undefined
}

/** 推理摘要播报（与正文 `token` 事件区分开）；`step` 是本轮内的工具迭代序号。 */
export interface AgentReasonEvent {
  readonly type: 'reason'
  readonly content: string
  readonly step: number
  readonly timestamp: number
}

/** 上下文压缩事件的播报；token 数为估算值，只用于展示压缩量级，不参与任何判定。 */
export interface AgentCompactionEvent {
  readonly type: 'compaction'
  readonly trigger: 'auto' | 'manual'
  readonly preTokens: number
  readonly postTokens: number
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
