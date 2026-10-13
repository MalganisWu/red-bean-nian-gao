import type { FastifyInstance } from 'fastify'

import { authenticatedRequest } from '../../shared/http/authenticated-request.js'
import type { AuthServicePort } from '../identity/public-api.js'
import type { StorageService } from './service/application/storage-service.js'
import { StorageController } from './controller/storage.controller.js'
import { registerStorageRoutes as bindStorageRoutes } from './controller/storage.routes.js'

/** Storage HTTP 驱动适配器的组装依赖。 */
export interface StorageRouteDependencies {
  readonly storageService: StorageService
  readonly authService: AuthServicePort
}

/**
 * 创建 Storage Controller 与认证边界，再注册承载请求解包与信封输出的路由表。
 *
 * HTTP 驱动适配器的对外入口：把用例服务组装成可挂载的路由，认证策略在此一次性绑定，
 * Controller 因此保持与 Fastify 解耦。本函数不持有资源，无关闭责任。
 *
 * @param server - 目标 Fastify 实例，路由直接挂载到它上面
 * @param dependencies - 已由 Module 组装好的用例服务与认证服务；认证器由此构造
 */
export function registerStorageRoutes(
  server: FastifyInstance,
  dependencies: StorageRouteDependencies
): void {
  bindStorageRoutes(
    server,
    new StorageController(dependencies.storageService),
    authenticatedRequest(dependencies.authService)
  )
}
