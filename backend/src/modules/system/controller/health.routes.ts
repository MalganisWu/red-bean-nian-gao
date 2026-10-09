import { API_ROUTES } from '@red-bean/api-contract'
import type { FastifyInstance } from 'fastify'

import { bindRoute } from '../../../shared/http/bind-route.js'
import { requestAbortSignal } from '../../../shared/http/fastify-http-boundary.js'
import type { HealthController } from './health.controller.js'

/**
 * 路由层将部署探针结果投影为 HTTP 响应并决定状态码，不持有健康检查实现；
 * 探针响应为裸 body（非业务信封），与全局 setErrorHandler 的错误信封互不干扰。
 * 端点执行链路：onRequest(全局) → handler → 裸响应（无认证、无限流）。
 */
export function registerHealthRoutes(server: FastifyInstance, controller: HealthController): void {
  // GET /health → HealthController.health（裸响应）
  bindRoute(server, API_ROUTES.HEALTH, {
    handler: async (_request, reply): Promise<void> => {
      await reply.status(200).send(controller.health())
    },
  })
  // GET /readyz → HealthController.ready（裸响应，聚合依赖状态）
  bindRoute(server, API_ROUTES.READYZ, {
    handler: async (request, reply): Promise<void> => {
      const result = await controller.ready(requestAbortSignal(request))
      await reply.status(result.status).send(result.body)
    },
  })
  // GET /version → HealthController.version（裸响应）
  bindRoute(server, API_ROUTES.VERSION, {
    handler: async (_request, reply): Promise<void> => {
      await reply.status(200).send(controller.version())
    },
  })
}
