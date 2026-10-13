import type { FastifyInstance } from 'fastify'

import { authenticatedRequest } from '../../shared/http/authenticated-request.js'
import { FixedWindowRateLimiter } from '../../shared/http/fastify-http-boundary.js'
import type { IdentityProfileService } from './service/application/profile/identity-profile-service.js'
import type { IdentityRegistrationService } from './service/application/registration/identity-registration-service.js'
import type { AuthServicePort } from './service/authentication/port/auth-service.port.js'
import { IdentityController } from './controller/identity.controller.js'
import { registerUserRoutes as bindUserRoutes } from './controller/identity.routes.js'

/** Identity HTTP 驱动适配器的组装依赖。 */
export interface UserRouteDependencies {
  /** 注册用例服务；由 Module 组装，本函数不新建仓储或散列器。 */
  readonly registration: IdentityRegistrationService
  /** 资料用例服务；自有视图与公开视图的读取与更新都由它承担。 */
  readonly profiles: IdentityProfileService
  /** 认证端口；既用于构造控制器，也用于生成鉴权前置处理器。 */
  readonly authService: AuthServicePort
}

/**
 * 创建 Identity Controller、认证和限流器，再注册承载请求解包与信封输出的路由表。
 *
 * HTTP 驱动适配器的对外入口：把用例服务组装成可挂载的路由。限流阈值在此固化，
 * 属于传输层策略，不进入业务用例。
 *
 * @param server - 目标 Fastify 实例，路由直接挂载到它上面
 * @param dependencies - 已由 Module 组装好的用例服务；认证器由此构造，不在此新建仓储
 */
export function registerUserRoutes(
  server: FastifyInstance,
  dependencies: UserRouteDependencies
): void {
  const controller = new IdentityController({
    registration: dependencies.registration,
    authentication: dependencies.authService,
    profiles: dependencies.profiles,
  })
  const registerLimiter = new FixedWindowRateLimiter({
    limit: 5,
    windowMilliseconds: 60 * 60 * 1_000,
  })
  const loginLimiter = new FixedWindowRateLimiter({
    limit: 10,
    windowMilliseconds: 10 * 60 * 1_000,
  })
  bindUserRoutes(server, {
    controller,
    authenticate: authenticatedRequest(dependencies.authService),
    limitRegistration: registerLimiter.preHandler(),
    limitLogin: loginLimiter.preHandler(),
  })
}
