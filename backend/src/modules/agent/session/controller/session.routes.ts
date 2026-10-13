import { API_ROUTES } from '@red-bean/api-contract'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify'

import { bindRoute } from '../../../../shared/http/bind-route.js'
import { authenticatedPrincipal } from '../../../../shared/http/authenticated-request.js'
import { requestAbortSignal } from '../../../../shared/http/fastify-http-boundary.js'
import { envelope, sendOk } from '../../../../shared/http/response.js'
import type { SessionController } from './session.controller.js'
import { parseSessionId, parseSessionPagination } from './session-request-parser.js'

/**
 * 路由文件承载端点、认证策略、请求解包与成功信封；
 * Controller 保持与 Fastify 解耦的用例签名（入参标量 + 返回 DTO），此处不内联任何 Schema/serializer。
 *
 * @param server - 目标 Fastify 实例，路由就地注册到它上面，无返回值供调用方串联。
 * @param controller - 会话查询控制器；本函数只接线，不持有其生命周期。
 * @param authenticate - 认证前置钩子，两条路由都必须挂上，缺失即等同于开放访问。
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
    handler: (request, reply) => listSessions(controller, request, reply),
  })
  // GET /api/sessions/:id → SessionController.detail
  // 链路：auth → controller.detail → 信封
  bindRoute(server, API_ROUTES.SESSION, {
    auth: authenticate,
    handler: (request, reply) => getSessionDetail(controller, request, reply),
  })
}

/**
 * GET /api/sessions：按游标分页列出当前用户的会话。
 *
 * 只负责解包与信封：分页参数经共享解析器兜底，用户身份取自认证主体，随后整包交给 Controller，
 * 使 Controller 保持与 Fastify 解耦。
 *
 * @param controller - 会话查询控制器，承接解包后的标量入参
 * @param request - Fastify 请求对象，提供 query、认证主体与中止信号
 * @param reply - Fastify 响应对象，用于发送成功信封
 */
async function listSessions(
  controller: SessionController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
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
}

/**
 * GET /api/sessions/:id：返回单个会话详情。
 *
 * 路径参数经共享解析器校验，非法 ID 会在此处以 400 终止，不会带着坏参数进入 Controller。
 *
 * @param controller - 会话查询控制器，承接解包后的标量入参
 * @param request - Fastify 请求对象，提供路径参数、认证主体与中止信号
 * @param reply - Fastify 响应对象，用于发送成功信封
 */
async function getSessionDetail(
  controller: SessionController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
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
}
