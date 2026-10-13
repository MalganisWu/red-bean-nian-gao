import type { SessionDetailDto, SessionListDto, SessionSummaryDto } from './dto.js'
import { z } from 'zod'
import { isArrayOf, isNumber, isRecord, isString } from '../common/schema.js'
import { isPersistedDisplayMessage } from '../presentation/schema.js'

/** 会话 ID 的路径参数校验。 */
export const sessionParamsSchema = z.object({ id: z.string().min(1) })

function isSessionSummary(value: unknown): value is SessionSummaryDto {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isString(value['title']) &&
    isNumber(value['message_count']) &&
    isString(value['updated_at'])
  )
}

/**
 * 会话列表页的守卫；逐项过内部的 `isSessionSummary`。
 * @param value - 待判定的列表响应；`sessions` 每项与 `next_cursor` 都必须合法。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isSessionList(value: unknown): value is SessionListDto {
  return (
    isRecord(value) &&
    isArrayOf(value['sessions'], isSessionSummary) &&
    isString(value['next_cursor'])
  )
}

/**
 * 会话详情的守卫；消息逐条过 `isPersistedDisplayMessage`。
 * @param value - 待判定的详情响应；`id` 必需，`messages` 每条都要合法。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isSessionDetail(value: unknown): value is SessionDetailDto {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isArrayOf(value['messages'], isPersistedDisplayMessage)
  )
}
