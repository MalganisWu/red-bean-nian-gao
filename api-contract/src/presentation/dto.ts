import type { QuestionAnswerDto, QuestionDto } from '../chat/dto.js'

/** 卡片 section 的持久化载荷；`answers` 可为 null（尚未作答）或缺省。 */
export interface CardSectionDataDto {
  readonly interaction_id: string
  readonly status: 'pending' | 'answered' | 'refused'
  readonly questions: QuestionDto[]
  readonly answers?: Readonly<Record<string, QuestionAnswerDto>> | null | undefined
}

/** 工具调用的持久化投影；`status` 五态覆盖运行中、成功、失败、取消与未闭合。 */
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

/** reason section 里的一项：要么是一段思考文本，要么是一次工具调用。 */
export interface ReasonItemDto {
  readonly itemType: 'step' | 'tool'
  readonly index?: number | undefined
  readonly content?: string | undefined
  readonly tool?: PersistedToolCardDto | undefined
}

/** 子 Agent section 的载荷；`status` 可缺省（早期写入的记录没有这个字段）。 */
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

/** 展示消息中 section 的可辨识联合；`type` 决定其余字段，消费方必须先分支再取值。 */
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

/** 消息由定时任务产生时的来源信息；`completed_at` 可缺省（执行尚未结束）。 */
export interface ScheduledTaskMetaDto {
  readonly task_id: string
  readonly task_name: string
  readonly status: 'completed' | 'failed'
  readonly execution_id: string
  readonly scheduled_at: number
  readonly completed_at?: number | undefined
}

/** 展示元信息；`process_status` 目前只有 `cancelled` 一个取值，用于标记被中断的过程块。 */
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
