import type { FastifyInstance } from 'fastify'

import { HealthController } from './controller/health.controller.js'
import { registerHealthRoutes as bindHealthRoutes } from './controller/health.routes.js'
import type { HealthServicePort } from './service/health/port/health-service.port.js'

/**
 * 创建 System Controller，再注册只负责映射的部署探针路由。
 *
 * @param server - 目标 Fastify 实例，探针路由注册到它上面。
 * @param health - 探针服务 Port；实现由调用方注入，本函数不做实现选择。
 */
export function registerHealthRoutes(server: FastifyInstance, health: HealthServicePort): void {
  bindHealthRoutes(server, new HealthController(health))
}
