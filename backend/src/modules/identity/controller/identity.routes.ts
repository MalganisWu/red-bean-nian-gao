import { API_ROUTES } from '@red-bean/api-contract'
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'

import { bindRoute } from '../../../shared/http/bind-route.js'
import { authenticatedPrincipal, firstHeader } from '../../../shared/http/authenticated-request.js'
import { requestAbortSignal } from '../../../shared/http/fastify-http-boundary.js'
import { validationError } from '../../../shared/http/error-mapper.js'
import { envelope, sendOk } from '../../../shared/http/response.js'
import type { IdentityController } from './identity.controller.js'
import {
  parseLoginDto,
  parseRegisterUserDto,
  parseUpdateSelfDto,
  parseUserId,
  parseUserPagination,
} from './identity-request-parser.js'

/** Identity 路由绑定所需的 Controller 与传输层前置处理器。 */
export interface IdentityRouteBindings {
  readonly controller: IdentityController
  readonly authenticate: preHandlerAsyncHookHandler
  readonly limitRegistration: preHandlerAsyncHookHandler
  readonly limitLogin: preHandlerAsyncHookHandler
}

/**
 * 路由文件承载端点、认证策略、请求解包（含 Bearer）与成功信封；
 * Controller 保持与 Fastify 解耦的用例签名（入参 DTO + 返回 DTO），此处不内联任何 Schema/serializer。
 * 端点执行链路（Fastify 生命周期，自左向右）：onRequest(全局 Abort+CORS+trace)
 * → preHandler auth → preHandler 限流 → handler zod 校验 → Controller 业务 → 成功信封；
 * 错误由全局 setErrorHandler 统一输出。各端点差异见下方链路指纹注释。
 */
export function registerUserRoutes(server: FastifyInstance, bindings: IdentityRouteBindings): void {
  // POST /api/register → IdentityController.register → IdentityRegistrationService.register
  // 链路：限流(5/h) → zod 校验(parseRegisterUserDto) → controller.register → 信封(201)
  bindRoute(server, API_ROUTES.REGISTER, {
    preHandler: [bindings.limitRegistration],
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await bindings.controller.register(
            parseRegisterUserDto(request.body),
            requestAbortSignal(request)
          )
        ),
        201
      )
    },
  })

  // POST /api/login → IdentityController.login → DefaultAuthService.login
  // 链路：限流(10/h) → zod 校验(parseLoginDto) → controller.login → 信封
  bindRoute(server, API_ROUTES.LOGIN, {
    preHandler: [bindings.limitLogin],
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await bindings.controller.login(parseLoginDto(request.body), requestAbortSignal(request))
        )
      )
    },
  })

  // POST /api/logout → IdentityController.logout → DefaultAuthService.logout
  // 链路：Bearer 解析(bearerToken) → controller.logout → 信封
  bindRoute(server, API_ROUTES.LOGOUT, {
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await bindings.controller.logout(bearerToken(request), requestAbortSignal(request))
        )
      )
    },
  })

  // POST /api/refresh → IdentityController.refresh → DefaultAuthService.refresh
  // 链路：Bearer 解析(bearerToken) → controller.refresh → 信封
  bindRoute(server, API_ROUTES.REFRESH, {
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await bindings.controller.refresh(bearerToken(request), requestAbortSignal(request))
        )
      )
    },
  })

  // GET /api/me → IdentityController.self → IdentityProfileService
  // 链路：auth → controller.self(userId) → 信封
  bindRoute(server, API_ROUTES.ME, {
    auth: bindings.authenticate,
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await bindings.controller.self(
            authenticatedPrincipal(request).userId,
            requestAbortSignal(request)
          )
        )
      )
    },
  })

  // PUT /api/me → IdentityController.updateSelf → IdentityProfileService
  // 链路：auth → zod 校验(parseUpdateSelfDto) → controller.updateSelf → 信封
  bindRoute(server, API_ROUTES.ME_UPDATE, {
    auth: bindings.authenticate,
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await bindings.controller.updateSelf(
            parseUpdateSelfDto(request.body),
            authenticatedPrincipal(request).userId,
            requestAbortSignal(request)
          )
        )
      )
    },
  })

  // GET /api/users/:id → IdentityController.detail → IdentityProfileService
  // 链路：auth → zod 校验(parseUserId) → controller.detail → 信封
  bindRoute(server, API_ROUTES.USER, {
    auth: bindings.authenticate,
    handler: async (request, reply): Promise<void> => {
      await sendOk(
        reply,
        envelope(
          await bindings.controller.detail(parseUserId(request.params), requestAbortSignal(request))
        )
      )
    },
  })

  // GET /api/users → IdentityController.list → IdentityProfileService
  // 链路：auth → zod 校验(parseUserPagination) → controller.list → 信封
  bindRoute(server, API_ROUTES.USERS, {
    auth: bindings.authenticate,
    handler: async (request, reply): Promise<void> => {
      const { offset, limit } = parseUserPagination(request.query)
      await sendOk(
        reply,
        envelope(await bindings.controller.list(offset, limit, requestAbortSignal(request)))
      )
    },
  })
}

/** 从认证头提取 Bearer token；logout/refresh 不经过 authenticate 前置处理器，需要独立解析。 */
function bearerToken(request: FastifyRequest): string {
  const authorization = firstHeader(request.headers.authorization)
  if (authorization === undefined || authorization === '') throw validationError('缺少认证凭证')
  return authorization.startsWith('Bearer ') && authorization.length > 'Bearer '.length
    ? authorization.slice('Bearer '.length)
    : authorization
}
