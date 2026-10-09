import type { PersistedDisplayMessageDto } from '../presentation/dto.js'

export interface SessionSummaryDto {
  readonly id: string
  readonly title: string
  readonly message_count: number
  readonly updated_at: string
}

export interface SessionListDto {
  readonly sessions: SessionSummaryDto[]
  readonly next_cursor: string
}

export interface SessionDetailDto {
  readonly id: string
  readonly messages: PersistedDisplayMessageDto[]
}
