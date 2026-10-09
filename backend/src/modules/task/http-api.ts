import type { FastifyInstance } from 'fastify'

import { authenticatedRequest } from './../../shared/http/authenticated-request.js'
import type { AuthServicePort } from './../identity/public-api.js'
import { TaskController, type TaskControllerDependencies } from './controller/task.controller.js'
import { registerTaskRoutes as bindTaskRoutes } from './controller/task.routes.js'

/** Task HTTP 驱动适配器的组装依赖。 */
export interface TaskRouteDependencies extends TaskControllerDependencies {
  readonly authService: AuthServicePort
}

/** 创建 Task Controller 与认证边界，再注册承载请求解包与信封输出的路由表。 */
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
