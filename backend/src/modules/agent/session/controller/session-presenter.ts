import { isPersistedDisplayMessage, type PersistedDisplayMessageDto } from '@red-bean/api-contract'

import { serializeDisplayMessage } from '../../presentation/presenter/display-message-presenter.js'
import type { Session, SessionSummary } from '../model/session.js'
import type { SessionDetailDto, SessionSummaryDto } from './session.dto.js'

export function toSessionSummaryDto(summary: SessionSummary): SessionSummaryDto {
  return {
    id: summary.id,
    title: summary.title,
    message_count: summary.messageCount,
    updated_at: summary.updatedAt.toISOString(),
  }
}

export function toSessionDetailDto(session: Session): SessionDetailDto {
  return {
    id: session.id,
    messages: session.displayMessages.map((message) => toPersistedDisplayMessageDto(message)),
  }
}

function toPersistedDisplayMessageDto(
  message: Session['displayMessages'][number]
): PersistedDisplayMessageDto {
  const serialized = serializeDisplayMessage(message)
  if (!isPersistedDisplayMessage(serialized)) {
    throw new Error('会话展示消息不符合共享 API 契约')
  }
  return serialized
}
