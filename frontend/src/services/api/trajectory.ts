import type { SessionTrajectoryDto } from '@red-bean/api-contract'
import { API_ROUTES, buildPath } from '@red-bean/api-contract'

import { apiCall } from './client'
import { decodeEnvelopeData, isSessionTrajectory } from './response-validation'

export type { SessionTrajectoryDto }

/** 读取会话轨迹（只读审计视图）。 */
export async function fetchSessionTrajectory(sessionId: string): Promise<SessionTrajectoryDto> {
  return apiCall(buildPath(API_ROUTES.SESSION_TRAJECTORY.path, { id: sessionId }), {}, (value) =>
    decodeEnvelopeData(value, isSessionTrajectory, 'session trajectory')
  )
}
