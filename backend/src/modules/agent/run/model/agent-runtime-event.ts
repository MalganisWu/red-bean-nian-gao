import type { AgentJsonObject } from '../../model/json-value.js'

export const AGENT_EVENT_TYPES = Object.freeze({
  TOKEN: 'token',
  STATUS: 'status',
  TOOL_START: 'tool_start',
  TOOL_RESULT: 'tool_result',
  REASON: 'reason',
  COMPACTION: 'compaction',
} as const)

export const AGENT_STATUS_CODES = Object.freeze({
  THINKING: 'thinking',
  ANALYZING_RESULTS: 'analyzing_results',
  LLM_RETRY: 'llm_retry',
  LLM_EMPTY_RESPONSE_RETRY: 'llm_empty_response_retry',
} as const)

export type AgentStatusCode = (typeof AGENT_STATUS_CODES)[keyof typeof AGENT_STATUS_CODES]

export interface AgentTokenEvent {
  readonly type: 'token'
  readonly content: string
}

export interface AgentStatusEvent {
  readonly type: 'status'
  readonly code?: AgentStatusCode | undefined
  readonly attempt?: number | undefined
  readonly maxAttempts?: number | undefined
}

export interface AgentToolStartEvent {
  readonly type: 'tool_start'
  readonly toolName: string
  readonly callId: string
  readonly params: AgentJsonObject | null
}

export interface AgentToolResultEvent {
  readonly type: 'tool_result'
  readonly toolName: string
  readonly callId: string
  readonly content: string
  readonly error?: string | undefined
}

export interface AgentReasonEvent {
  readonly type: 'reason'
  readonly content: string
  readonly step: number
  readonly timestamp: number
}

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
