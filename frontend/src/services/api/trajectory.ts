import type { SessionTrajectoryDto } from '@red-bean/api-contract'
import { API_ROUTES, buildPath } from '@red-bean/api-contract'

import { apiCall } from './client'
import { decodeEnvelopeData, isSessionTrajectory } from './response-validation'

export type { SessionTrajectoryDto }

/**
 * 读取会话轨迹（只读审计视图）。
 *
 * @param sessionId - 会话标识，经 buildPath 填入路由模板；响应经 isSessionTrajectory 校验后收窄为 SessionTrajectoryDto。
 * @returns 会话的轨迹投影。
 */
export async function fetchSessionTrajectory(sessionId: string): Promise<SessionTrajectoryDto> {
  return apiCall(buildPath(API_ROUTES.SESSION_TRAJECTORY.path, { id: sessionId }), {}, (value) =>
    decodeEnvelopeData(value, isSessionTrajectory, 'session trajectory')
  )
}
