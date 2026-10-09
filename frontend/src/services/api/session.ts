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

export async function fetchSessions(cursor?: string, limit?: number): Promise<SessionListResponse> {
  const c = cursor ?? ''
  const l = limit ?? 20
  return apiCall(
    `${API_ROUTES.SESSIONS.path}?cursor=${encodeURIComponent(c)}&limit=${l}`,
    {},
    (value) => decodeEnvelopeData(value, isSessionListResponse, 'session list')
  )
}

export async function fetchSession(sessionId: string): Promise<SessionDetail> {
  return apiCall(buildPath(API_ROUTES.SESSION.path, { id: sessionId }), {}, (value) =>
    decodeEnvelopeData(value, isSessionDetail, 'session detail')
  )
}
