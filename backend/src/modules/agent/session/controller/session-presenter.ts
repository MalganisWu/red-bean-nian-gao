import { isPersistedDisplayMessage, type PersistedDisplayMessageDto } from '@red-bean/api-contract'

import { serializeDisplayMessage } from '../../presentation/presenter/display-message-presenter.js'
import type { Session, SessionSummary } from '../model/session.js'
import type { SessionDetailDto, SessionSummaryDto } from './session.dto.js'

/**
 * 会话摘要 → wire DTO；时间转 ISO，字段名转 snake_case。
 *
 * @param summary - 仓储层产出的会话摘要，`updatedAt` 必须是有效的 Date，否则 `toISOString` 会抛错。
 * @returns 可直接序列化进响应信封的摘要 DTO。
 */
export function toSessionSummaryDto(summary: SessionSummary): SessionSummaryDto {
  return {
    id: summary.id,
    title: summary.title,
    message_count: summary.messageCount,
    updated_at: summary.updatedAt.toISOString(),
  }
}

/**
 * 会话详情 → wire DTO；每条消息都过契约校验，不符合就抛错，而不是尽力输出一个残缺结构。
 *
 * @param session - 会话聚合根；只读取 `id` 与 `displayMessages`，不写回。
 * @returns 详情 DTO；任一条消息未通过共享契约校验时抛出，不产出残缺结构。
 */
export function toSessionDetailDto(session: Session): SessionDetailDto {
  return {
    id: session.id,
    messages: session.displayMessages.map((message) => toPersistedDisplayMessageDto(message)),
  }
}

/**
 * 把单条展示消息序列化后按共享契约校验，校验不过即抛错，而非尽力输出一个残缺结构。
 *
 * 详情接口与历史回放共用同一投影，字段漂移必须在这里当场暴露：一旦放行契约外的形状，
 * 前端会在解析响应时才失败，定位成本远高于在服务端边界直接报错。
 *
 * @param message - 会话聚合根里的一条展示消息
 * @returns 通过共享契约校验的持久化展示消息 DTO；校验失败时抛出
 */
function toPersistedDisplayMessageDto(
  message: Session['displayMessages'][number]
): PersistedDisplayMessageDto {
  const serialized = serializeDisplayMessage(message)
  if (!isPersistedDisplayMessage(serialized)) {
    throw new Error('会话展示消息不符合共享 API 契约')
  }
  return serialized
}
