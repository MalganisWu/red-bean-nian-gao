import type {
  SessionDetailDto as SessionDetail,
  SessionListDto as SessionListResponse,
  SessionSummaryDto as SessionSummary,
} from '@red-bean/api-contract'
import { API_ROUTES, buildPath } from '@red-bean/api-contract'

import { apiCall } from './client'
import { decodeEnvelopeData, isSessionDetail, isSessionListResponse } from './response-validation'

export type { SessionDetail, SessionListResponse, SessionSummary }

// ── API 调用 ────────────────────────────────────────────

/**
 * 分页拉取会话列表；游标与条数缺省时落到默认值（空串 / 20）。
 *
 * @param cursor - 上一页返回的游标；缺省空串表示从最新一页开始。
 * @param limit - 单页条数，缺省 20；响应经 isSessionListResponse 校验后收窄为 SessionListResponse。
 * @returns 一页会话列表（含下一页游标）。
 */
export async function fetchSessions(cursor?: string, limit?: number): Promise<SessionListResponse> {
  const c = cursor ?? ''
  const l = limit ?? 20
  return apiCall(
    `${API_ROUTES.SESSIONS.path}?cursor=${encodeURIComponent(c)}&limit=${l}`,
    {},
    (value) => decodeEnvelopeData(value, isSessionListResponse, 'session list')
  )
}

/**
 * 按 id 拉取单个会话详情。
 *
 * @param sessionId - 会话标识，经 buildPath 填入路由模板；响应经 isSessionDetail 校验后收窄为 SessionDetail。
 * @returns 会话详情。
 */
export async function fetchSession(sessionId: string): Promise<SessionDetail> {
  return apiCall(buildPath(API_ROUTES.SESSION.path, { id: sessionId }), {}, (value) =>
    decodeEnvelopeData(value, isSessionDetail, 'session detail')
  )
}
