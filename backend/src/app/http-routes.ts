import type { FastifyInstance } from 'fastify'

import {
  registerChatRoutes,
  type ChatRouteDependencies,
  registerSessionRoutes,
  type SessionRouteDependencies,
  registerTrajectoryRoutes,
  type TrajectoryRouteDependencies,
} from '../modules/agent/http-api.js'
import type { HealthServicePort } from '../modules/system/public-api.js'
import { registerHealthRoutes } from '../modules/system/http-api.js'
import {
  registerStorageRoutes,
  type StorageRouteDependencies,
} from '../modules/storage/http-api.js'
import { registerTaskRoutes, type TaskRouteDependencies } from '../modules/task/http-api.js'
import { registerUserRoutes, type UserRouteDependencies } from '../modules/identity/http-api.js'

export interface ApplicationRouteDependencies {
  readonly health: HealthServicePort
  readonly chat: ChatRouteDependencies
  readonly sessions: SessionRouteDependencies
  readonly trajectories: TrajectoryRouteDependencies
  readonly storage: StorageRouteDependencies
  readonly tasks: TaskRouteDependencies
  readonly users: UserRouteDependencies
}

/** 生产启动和路由契约测试共用的唯一注册入口。 */
export function registerApplicationRoutes(
  server: FastifyInstance,
  dependencies: ApplicationRouteDependencies
): void {
  registerHealthRoutes(server, dependencies.health)
  registerChatRoutes(server, dependencies.chat)
  registerSessionRoutes(server, dependencies.sessions)
  registerTrajectoryRoutes(server, dependencies.trajectories)
  registerUserRoutes(server, dependencies.users)
  registerStorageRoutes(server, dependencies.storage)
  registerTaskRoutes(server, dependencies.tasks)
}
