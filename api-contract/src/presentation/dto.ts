import type { QuestionAnswerDto, QuestionDto } from '../chat/dto.js'

export interface CardSectionDataDto {
  readonly interaction_id: string
  readonly status: 'pending' | 'answered' | 'refused'
  readonly questions: QuestionDto[]
  readonly answers?: Readonly<Record<string, QuestionAnswerDto>> | null | undefined
}

export interface PersistedToolCardDto {
  readonly callId: string
  readonly name: string
  readonly label?: string | undefined
  readonly params?: string | undefined
  readonly result?: string | undefined
  readonly error?: string | undefined
  readonly status: 'running' | 'success' | 'failed' | 'cancelled' | 'incomplete'
  readonly duration?: string | number | undefined
  readonly durationMs?: number | undefined
  readonly startedAtMs?: number | undefined
}

export interface ReasonItemDto {
  readonly itemType: 'step' | 'tool'
  readonly index?: number | undefined
  readonly content?: string | undefined
  readonly tool?: PersistedToolCardDto | undefined
}

export interface PersistedSubAgentSectionDataDto {
  readonly agent_id: string
  readonly agent_name: string
  readonly execution_id: string
  readonly sections: PersistedMessageSectionDto[]
  readonly status?:
    'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled' | 'incomplete' | undefined
  readonly result_summary?: string | undefined
  readonly parent_call_id?: string | undefined
}

export type PersistedMessageSectionDto =
  | {
      readonly type: 'reason'
      readonly items: ReasonItemDto[]
      readonly timestamp: number
      readonly duration?: number | undefined
    }
  | {
      readonly type: 'tool_group'
      readonly tools: PersistedToolCardDto[]
      readonly timestamp: number
      readonly duration?: number | undefined
    }
  | {
      readonly type: 'content'
      readonly content: string
      readonly timestamp: number
      readonly duration?: number | undefined
    }
  | { readonly type: 'card'; readonly card: CardSectionDataDto; readonly timestamp: number }
  | {
      readonly type: 'sub_agent'
      readonly items: PersistedSubAgentSectionDataDto
      readonly timestamp: number
    }

export interface ScheduledTaskMetaDto {
  readonly task_id: string
  readonly task_name: string
  readonly status: 'completed' | 'failed'
  readonly execution_id: string
  readonly scheduled_at: number
  readonly completed_at?: number | undefined
}

export interface DisplayMessageMetaDto {
  readonly scheduled_task?: ScheduledTaskMetaDto | undefined
  readonly run_started_at?: number | undefined
  readonly process_status?: 'cancelled' | undefined
}

/** 会话详情和任务执行结果共同使用的持久化消息 wire DTO。 */
export interface PersistedDisplayMessageDto {
  readonly role: 'user' | 'assistant'
  readonly content?: string | undefined
  readonly sections?: PersistedMessageSectionDto[] | undefined
  readonly source?: string | undefined
  readonly meta?: DisplayMessageMetaDto | undefined
  readonly timestamp: number
}
