import type { PersistedDisplayMessageDto } from '../presentation/dto.js'

/** 会话列表项；`message_count` 是展示消息条数，`updated_at` 为 ISO 字符串。 */
export interface SessionSummaryDto {
  readonly id: string
  readonly title: string
  readonly message_count: number
  readonly updated_at: string
}

/** 会话列表页；`next_cursor` 为空串表示没有下一页。 */
export interface SessionListDto {
  readonly sessions: SessionSummaryDto[]
  readonly next_cursor: string
}

/** 会话详情；只带展示消息，不含运行时状态与版本字段。 */
export interface SessionDetailDto {
  readonly id: string
  readonly messages: PersistedDisplayMessageDto[]
}
