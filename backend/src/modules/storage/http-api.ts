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

/** 创建 Storage Controller 与认证边界，再注册承载请求解包与信封输出的路由表。 */
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
