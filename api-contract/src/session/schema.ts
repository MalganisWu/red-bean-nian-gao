import type { SessionDetailDto, SessionListDto, SessionSummaryDto } from './dto.js'
import { z } from 'zod'
import { isArrayOf, isNumber, isRecord, isString } from '../common/schema.js'
import { isPersistedDisplayMessage } from '../presentation/schema.js'

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

export function isSessionList(value: unknown): value is SessionListDto {
  return (
    isRecord(value) &&
    isArrayOf(value['sessions'], isSessionSummary) &&
    isString(value['next_cursor'])
  )
}

export function isSessionDetail(value: unknown): value is SessionDetailDto {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isArrayOf(value['messages'], isPersistedDisplayMessage)
  )
}
