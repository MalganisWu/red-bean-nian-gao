import type { FastifyInstance } from 'fastify'

import { authenticatedRequest } from './../../shared/http/authenticated-request.js'
import type { AuthServicePort } from './../identity/public-api.js'
import { TaskController, type TaskControllerDependencies } from './controller/task.controller.js'
import { registerTaskRoutes as bindTaskRoutes } from './controller/task.routes.js'

/** Task HTTP 驱动适配器的组装依赖。 */
export interface TaskRouteDependencies extends TaskControllerDependencies {
  /** 认证服务 Port；用于构造请求级 Principal 边界，不在此处直接鉴权。 */
  readonly authService: AuthServicePort
}

/**
 * 创建 Task Controller 与认证边界，再注册承载请求解包与信封输出的路由表。
 *
 * @param server - 目标 Fastify 实例，任务路由注册到它上面。
 * @param dependencies - 路由组装依赖：用例服务与认证服务 Port。
 */
export function registerTaskRoutes(
  server: FastifyInstance,
  dependencies: TaskRouteDependencies
): void {
  bindTaskRoutes(
    server,
    new TaskController(dependencies),
    authenticatedRequest(dependencies.authService)
  )
}
