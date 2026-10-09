import { API_ROUTES, trajectoryParamsSchema } from '@red-bean/api-contract'
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'

import { bindRoute } from '../../../../shared/http/bind-route.js'
import { authenticatedPrincipal } from '../../../../shared/http/authenticated-request.js'
import { validationError } from '../../../../shared/http/error-mapper.js'
import { requestAbortSignal } from '../../../../shared/http/fastify-http-boundary.js'
import { envelope, sendOk } from '../../../../shared/http/response.js'
import type { TrajectoryController } from './trajectory.controller.js'

/** 从路径参数解包会话 id（共享契约的 zod schema）。 */
function parseTrajectorySessionId(value: unknown): string {
  const parsed = trajectoryParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('会话 ID 不能为空')
  return parsed.data.id
}

/**
 * 轨迹路由承载端点、认证策略、请求解包与成功信封；
 * Controller 保持与 Fastify 解耦的用例签名，此处不内联任何 Schema/serializer。
 */
export function registerTrajectoryRoutes(
  server: FastifyInstance,
  controller: TrajectoryController,
  authenticate: preHandlerAsyncHookHandler
): void {
  // GET /api/sessions/:id/trajectory → TrajectoryController.get
  // 链路：auth → controller.get → 信封
  bindRoute(server, API_ROUTES.SESSION_TRAJECTORY, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await controller.get(
            authenticatedPrincipal(request).userId,
            parseTrajectorySessionId(request.params),
            requestAbortSignal(request)
          )
        )
      )
    },
  })
}
