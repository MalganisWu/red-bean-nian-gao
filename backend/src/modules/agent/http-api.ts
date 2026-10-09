import type { FastifyInstance } from 'fastify'

import { authenticatedRequest } from '../../shared/http/authenticated-request.js'
import type { AuthServicePort } from '../identity/public-api.js'
import { ChatController } from './chat/controller/chat.controller.js'
import { registerChatRoutes as bindChatRoutes } from './chat/controller/chat.routes.js'
import type { ChatUseCasePort } from './chat/port/chat-use-case.port.js'
import {
  SessionController,
  type SessionControllerDependencies,
} from './session/controller/session.controller.js'
import { registerSessionRoutes as bindSessionRoutes } from './session/controller/session.routes.js'
import {
  TrajectoryController,
  type TrajectoryControllerDependencies,
} from './trajectory/controller/trajectory.controller.js'
import { registerTrajectoryRoutes as bindTrajectoryRoutes } from './trajectory/controller/trajectory.routes.js'

/** Chat HTTP 驱动适配器的组装依赖；业务默认实现由 `agent.module.ts` 提供。 */
export interface ChatRouteDependencies {
  readonly chat: ChatUseCasePort
  readonly authService: AuthServicePort
}

/** Session HTTP 驱动适配器的组装依赖；业务默认实现由 `agent.module.ts` 提供。 */
export interface SessionRouteDependencies extends SessionControllerDependencies {
  readonly authService: AuthServicePort
}

/** Trajectory HTTP 驱动适配器的组装依赖；业务默认实现由 `agent.module.ts` 提供。 */
export interface TrajectoryRouteDependencies extends TrajectoryControllerDependencies {
  readonly authService: AuthServicePort
}

/** 创建 Chat Controller 与认证边界，再把纯路由表注册到 Fastify。 */
export function registerChatRoutes(
  server: FastifyInstance,
  dependencies: ChatRouteDependencies
): void {
  bindChatRoutes(
    server,
    new ChatController(dependencies.chat),
    authenticatedRequest(dependencies.authService)
  )
}

/** 创建 Session Controller 与认证边界，再把纯路由表注册到 Fastify。 */
export function registerSessionRoutes(
  server: FastifyInstance,
  dependencies: SessionRouteDependencies
): void {
  bindSessionRoutes(
    server,
    new SessionController(dependencies),
    authenticatedRequest(dependencies.authService)
  )
}

/** 创建 Trajectory Controller 与认证边界，再把纯路由表注册到 Fastify。 */
export function registerTrajectoryRoutes(
  server: FastifyInstance,
  dependencies: TrajectoryRouteDependencies
): void {
  bindTrajectoryRoutes(
    server,
    new TrajectoryController(dependencies),
    authenticatedRequest(dependencies.authService)
  )
}
