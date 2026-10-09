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
  readonly registration: IdentityRegistrationService
  readonly profiles: IdentityProfileService
  readonly authService: AuthServicePort
}

/** 创建 Identity Controller、认证和限流器，再注册承载请求解包与信封输出的路由表。 */
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
