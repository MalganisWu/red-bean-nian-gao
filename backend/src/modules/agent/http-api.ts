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
  /** Chat 入站用例；路由在认证通过后把请求交给它。 */
  readonly chat: ChatUseCasePort
  /** 认证服务；用来构造 authenticatedRequest 边界，路由不自行解析凭据。 */
  readonly authService: AuthServicePort
}

/** Session HTTP 驱动适配器的组装依赖；业务默认实现由 `agent.module.ts` 提供。 */
export interface SessionRouteDependencies extends SessionControllerDependencies {
  /** 认证服务；用来构造 authenticatedRequest 边界，路由不自行解析凭据。 */
  readonly authService: AuthServicePort
}

/** Trajectory HTTP 驱动适配器的组装依赖；业务默认实现由 `agent.module.ts` 提供。 */
export interface TrajectoryRouteDependencies extends TrajectoryControllerDependencies {
  /** 认证服务；用来构造 authenticatedRequest 边界，路由不自行解析凭据。 */
  readonly authService: AuthServicePort
}

/**
 * 创建 Chat Controller 与认证边界，再把纯路由表注册到 Fastify。
 *
 * @param server - 已建好但尚未监听的 Fastify 实例；本函数只注册路由，不启动服务。
 * @param dependencies - Chat 用例 Port 与认证服务；由本 Module 的组装入口提供，路由层不自行构造。
 * @returns 无返回值；注册是副作用，失败时直接抛出而不是返回错误。
 */
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

/**
 * 创建 Session Controller 与认证边界，再把纯路由表注册到 Fastify。
 *
 * @param server - 已建好但尚未监听的 Fastify 实例；本函数只注册路由，不启动服务。
 * @param dependencies - Session 用例 Port 与认证服务；路由层不自行构造依赖。
 * @returns 无返回值；注册是副作用，失败时直接抛出。
 */
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

/**
 * 创建 Trajectory Controller 与认证边界，再把纯路由表注册到 Fastify。
 *
 * @param server - 已建好但尚未监听的 Fastify 实例；本函数只注册路由，不启动服务。
 * @param dependencies - Trajectory 用例 Port 与认证服务；路由层不自行构造依赖。
 * @returns 无返回值；注册是副作用，失败时直接抛出。
 */
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
