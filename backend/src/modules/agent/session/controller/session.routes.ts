import { API_ROUTES } from '@red-bean/api-contract'
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'

import { bindRoute } from '../../../../shared/http/bind-route.js'
import { authenticatedPrincipal } from '../../../../shared/http/authenticated-request.js'
import { requestAbortSignal } from '../../../../shared/http/fastify-http-boundary.js'
import { envelope, sendOk } from '../../../../shared/http/response.js'
import type { SessionController } from './session.controller.js'
import { parseSessionId, parseSessionPagination } from './session-request-parser.js'

/**
 * 路由文件承载端点、认证策略、请求解包与成功信封；
 * Controller 保持与 Fastify 解耦的用例签名（入参标量 + 返回 DTO），此处不内联任何 Schema/serializer。
 */
export function registerSessionRoutes(
  server: FastifyInstance,
  controller: SessionController,
  authenticate: preHandlerAsyncHookHandler
): void {
  // GET /api/sessions → SessionController.list（游标分页）
  // 链路：auth → controller.list → 信封
  bindRoute(server, API_ROUTES.SESSIONS, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
      const { cursor, limit } = parseSessionPagination(request.query)
      await sendOk(
        reply,
        envelope(
          await controller.list(
            authenticatedPrincipal(request).userId,
            cursor,
            limit,
            requestAbortSignal(request)
          )
        )
      )
    },
  })
  // GET /api/sessions/:id → SessionController.detail
  // 链路：auth → controller.detail → 信封
  bindRoute(server, API_ROUTES.SESSION, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await controller.detail(
            authenticatedPrincipal(request).userId,
            parseSessionId(request.params),
            requestAbortSignal(request)
          )
        )
      )
    },
  })
}
