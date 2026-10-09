/** 聊天请求及 SSE wire DTO；不包含解析、展示或业务逻辑。 */
export interface ChatMessageDto {
  readonly role: 'assistant' | 'user'
  readonly content: string
}

export interface ChatRequestDto {
  readonly messages: ChatMessageDto[]
  readonly session_id?: string | undefined
  readonly agent_id?: string | undefined
}

export interface CancelRequestDto {
  readonly request_id: string
}

export interface QuestionAnswerDto {
  readonly kind: 'option' | 'multi' | 'custom' | 'skip'
  readonly value?: string | undefined
  readonly values?: string[] | undefined
}

export interface AnswerRequestDto {
  readonly session_id: string
  readonly interaction_id: string
  readonly agent_id?: string | undefined
  readonly answers?: Readonly<Record<string, QuestionAnswerDto>> | undefined
  readonly refused?: boolean | undefined
}

export interface StartEventDto {
  readonly request_id: string
  readonly session_id: string
  readonly trace_id: string
}

export interface TokenEventDto {
  readonly content: string
}

export interface StatusEventDto {
  readonly content: string
  readonly code?: string | undefined
  readonly attempt?: number | undefined
  readonly max_attempts?: number | undefined
}

export interface ToolStartEventDto {
  readonly tool_name: string
  readonly call_id: string
  readonly params: Readonly<Record<string, unknown>> | null
}

export interface ToolResultEventDto {
  readonly tool_name: string
  readonly call_id: string
  readonly content: string
  readonly error?: string | undefined
}

export interface DoneEventDto {
  readonly tokens_used: number
  readonly session_id: string
}

export interface ErrorEventDto {
  readonly code: number
  readonly message: string
}

export interface HeartbeatEventDto {
  readonly timestamp: number
}

export interface ReasonEventDto {
  readonly content: string
  readonly step: number
  readonly timestamp: number
}

export interface CompactionEventDto {
  readonly trigger: 'auto' | 'manual'
  readonly pre_tokens: number
  readonly post_tokens: number
  readonly messages_summarized: number
}

export interface QuestionDto {
  readonly id: string
  readonly text: string
  readonly description?: string | undefined
  readonly options?: string[] | undefined
  readonly select?: 'single' | 'multi' | undefined
}

export interface CardEventDto {
  readonly interaction_id: string
  readonly status: 'pending' | 'answered' | 'refused'
  readonly questions: QuestionDto[]
}

export interface SubAgentEnvelopeDto {
  readonly agent_id: string
  readonly agent_name: string
  readonly execution_id: string
  readonly parent_call_id: string
  readonly event_type: string
  readonly event: unknown
}
