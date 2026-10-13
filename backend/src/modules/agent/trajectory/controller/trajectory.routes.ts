import { API_ROUTES, trajectoryParamsSchema } from '@red-bean/api-contract'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify'

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
 *
 * @param server - 目标 Fastify 实例，路由就地注册到它上面。
 * @param controller - 轨迹查询控制器；本函数只接线，不持有其生命周期。
 * @param authenticate - 认证前置钩子，必须挂上，缺失即等同于开放访问。
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
    handler: (request, reply) => getSessionTrajectory(controller, request, reply),
  })
}

/** GET /api/sessions/:id/trajectory：返回单个会话的轨迹投影。 */
async function getSessionTrajectory(
  controller: TrajectoryController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
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
}
