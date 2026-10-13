import type { PersistedDisplayMessageDto } from '../presentation/dto.js'

/** 会话列表项；`message_count` 是展示消息条数，`updated_at` 为 ISO 字符串。 */
export interface SessionSummaryDto {
  /** 会话 ID。 */
  readonly id: string
  /** 会话标题；由服务端按首条消息生成，可能为空串。 */
  readonly title: string
  /** 展示消息条数，用于列表角标。 */
  readonly message_count: number
  /** 最近更新时刻，ISO 8601 字符串；格式化由前端负责。 */
  readonly updated_at: string
}

/** 会话列表页；`next_cursor` 为空串表示没有下一页。 */
export interface SessionListDto {
  /** 当前页的会话摘要列表。 */
  readonly sessions: SessionSummaryDto[]
  /** 下一页游标；空串表示没有下一页。 */
  readonly next_cursor: string
}

/** 会话详情；只带展示消息，不含运行时状态与版本字段。 */
export interface SessionDetailDto {
  /** 会话 ID。 */
  readonly id: string
  /** 会话内的展示消息，按时间升序排列。 */
  readonly messages: PersistedDisplayMessageDto[]
}
