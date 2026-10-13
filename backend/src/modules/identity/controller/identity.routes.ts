import { API_ROUTES } from '@red-bean/api-contract'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify'

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
  /** 已组装好的用例控制器；路由只负责解包请求、调用它并包成功信封。 */
  readonly controller: IdentityController
  /** 认证前置处理器；挂到需要 Principal 的端点上，失败时短路成 401。 */
  readonly authenticate: preHandlerAsyncHookHandler
  /** 注册限流前置处理器；注册端点专用，额度比登录更紧。 */
  readonly limitRegistration: preHandlerAsyncHookHandler
  /** 登录限流前置处理器；登录端点专用，超限短路成 429。 */
  readonly limitLogin: preHandlerAsyncHookHandler
}

/**
 * 路由文件承载端点、认证策略、请求解包（含 Bearer）与成功信封；
 * Controller 保持与 Fastify 解耦的用例签名（入参 DTO + 返回 DTO），此处不内联任何 Schema/serializer。
 * 端点执行链路（Fastify 生命周期，自左向右）：onRequest(全局 Abort+CORS+trace)
 * → preHandler auth → preHandler 限流 → handler zod 校验 → Controller 业务 → 成功信封；
 * 错误由全局 setErrorHandler 统一输出。各端点差异见下方链路指纹注释。
 *
 * @param server - 承载路由的 Fastify 实例；路径一律取自 `API_ROUTES`，本函数不手写路径字面量
 * @param bindings - 由组装层注入的 Controller 与前置处理器；认证策略在此按端点绑定，不做运行时挑选
 */
export function registerUserRoutes(server: FastifyInstance, bindings: IdentityRouteBindings): void {
  // POST /api/register → IdentityController.register → IdentityRegistrationService.register
  // 链路：限流(5/h) → zod 校验(parseRegisterUserDto) → controller.register → 信封(201)
  bindRoute(server, API_ROUTES.REGISTER, {
    preHandler: [bindings.limitRegistration],
    handler: (request, reply) => registerUser(bindings, request, reply),
  })

  // POST /api/login → IdentityController.login → DefaultAuthService.login
  // 链路：限流(10/h) → zod 校验(parseLoginDto) → controller.login → 信封
  bindRoute(server, API_ROUTES.LOGIN, {
    preHandler: [bindings.limitLogin],
    handler: (request, reply) => loginUser(bindings, request, reply),
  })

  // POST /api/logout → IdentityController.logout → DefaultAuthService.logout
  // 链路：Bearer 解析(bearerToken) → controller.logout → 信封
  bindRoute(server, API_ROUTES.LOGOUT, {
    handler: (request, reply) => logoutUser(bindings, request, reply),
  })

  // POST /api/refresh → IdentityController.refresh → DefaultAuthService.refresh
  // 链路：Bearer 解析(bearerToken) → controller.refresh → 信封
  bindRoute(server, API_ROUTES.REFRESH, {
    handler: (request, reply) => refreshSession(bindings, request, reply),
  })

  // GET /api/me → IdentityController.self → IdentityProfileService
  // 链路：auth → controller.self(userId) → 信封
  bindRoute(server, API_ROUTES.ME, {
    auth: bindings.authenticate,
    handler: (request, reply) => getSelfProfile(bindings, request, reply),
  })

  // PUT /api/me → IdentityController.updateSelf → IdentityProfileService
  // 链路：auth → zod 校验(parseUpdateSelfDto) → controller.updateSelf → 信封
  bindRoute(server, API_ROUTES.ME_UPDATE, {
    auth: bindings.authenticate,
    handler: (request, reply) => updateSelfProfile(bindings, request, reply),
  })

  // GET /api/users/:id → IdentityController.detail → IdentityProfileService
  // 链路：auth → zod 校验(parseUserId) → controller.detail → 信封
  bindRoute(server, API_ROUTES.USER, {
    auth: bindings.authenticate,
    handler: (request, reply) => getUserDetail(bindings, request, reply),
  })

  // GET /api/users → IdentityController.list → IdentityProfileService
  // 链路：auth → zod 校验(parseUserPagination) → controller.list → 信封
  bindRoute(server, API_ROUTES.USERS, {
    auth: bindings.authenticate,
    handler: (request, reply) => listUsers(bindings, request, reply),
  })
}

/**
 * POST /api/register：注册新用户并返回 201 信封。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，请求体取自 `request.body` 并在此先行校验
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function registerUser(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
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
}

/**
 * POST /api/login：校验凭据并签发令牌。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，登录体取自 `request.body` 并在此先行校验
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function loginUser(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await bindings.controller.login(parseLoginDto(request.body), requestAbortSignal(request))
    )
  )
}

/**
 * POST /api/logout：按 Bearer token 注销当前会话。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，令牌在此从认证头独立解析（该端点不挂 auth 前置处理器）
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function logoutUser(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(await bindings.controller.logout(bearerToken(request), requestAbortSignal(request)))
  )
}

/**
 * POST /api/refresh：按 Bearer token 续签令牌。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，令牌在此从认证头独立解析（该端点不挂 auth 前置处理器）
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function refreshSession(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(await bindings.controller.refresh(bearerToken(request), requestAbortSignal(request)))
  )
}

/**
 * GET /api/me：读取当前登录用户的资料。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，Principal 由 auth 前置处理器写入此处读出
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function getSelfProfile(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await bindings.controller.self(
        authenticatedPrincipal(request).userId,
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * PUT /api/me：按 DTO 更新当前登录用户的资料。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，更新体取自 `request.body`，写入目标取 Principal 的 userId
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function updateSelfProfile(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
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
}

/**
 * GET /api/users/:id：按 id 读取用户公开资料。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，目标用户 ID 取自路径参数并在此校验
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function getUserDetail(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await bindings.controller.detail(parseUserId(request.params), requestAbortSignal(request))
    )
  )
}

/**
 * GET /api/users：按 offset/limit 分页列出用户。
 *
 * @param bindings - 组装层注入的控制器与前置处理器集合
 * @param request - Fastify 请求对象，分页参数取自 `request.query` 并由解析层归一化
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function listUsers(
  bindings: IdentityRouteBindings,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { offset, limit } = parseUserPagination(request.query)
  await sendOk(
    reply,
    envelope(await bindings.controller.list(offset, limit, requestAbortSignal(request)))
  )
}

/**
 * 从认证头提取 Bearer token；logout/refresh 不经过 authenticate 前置处理器，需要独立解析。
 *
 * 缺头或空串一律抛 400，不静默放行；`Bearer ` 前缀存在时剥掉，否则按原文返回，
 * 以兼容历史客户端直接投递裸令牌的写法。
 *
 * @param request - Fastify 请求对象，认证头从 `request.headers.authorization` 读取
 * @returns 去掉 `Bearer ` 前缀后的令牌原文
 */
function bearerToken(request: FastifyRequest): string {
  const authorization = firstHeader(request.headers.authorization)
  if (authorization === undefined || authorization === '') throw validationError('缺少认证凭证')
  return authorization.startsWith('Bearer ') && authorization.length > 'Bearer '.length
    ? authorization.slice('Bearer '.length)
    : authorization
}
