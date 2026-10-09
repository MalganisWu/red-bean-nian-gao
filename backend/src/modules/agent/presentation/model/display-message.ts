import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'

export interface DisplayMessage {
  readonly role: string
  readonly content?: string
  readonly cards?: readonly Card[]
  readonly sections?: AgentJsonValue
  readonly source?: string
  readonly meta?: MessageMeta
  readonly timestamp: number
}

export interface MessageMeta {
  readonly scheduledTask?: ScheduledTaskMeta
  readonly runStartedAt?: number
}

export interface ScheduledTaskMeta {
  readonly taskId: string
  readonly taskName: string
  readonly status: string
  readonly executionId: string
  readonly scheduledAt: number
  readonly completedAt: number
}

export interface Card {
  readonly type: string
  readonly data: AgentJsonObject
}

export interface SectionItem {
  readonly type: string
  readonly content?: string
  readonly items?: AgentJsonValue
  readonly tools?: AgentJsonValue
  readonly card?: AgentJsonValue
  readonly timestamp: number
  readonly duration?: number
}

export interface ToolItem {
  readonly callId: string
  readonly name: string
  readonly status: string
  readonly result?: string
  readonly error?: string
  readonly duration?: number
}
