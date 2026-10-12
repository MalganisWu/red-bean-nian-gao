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

/**
 * 生产启动和路由契约测试共用的唯一注册入口。
 *
 * 「共用」是重点：契约测试走的就是这条函数，因此**不存在「生产注册了但测试没覆盖」的路由**。
 * 如果各模块自己在别处补注册，两边就会漂移，而路由表偏偏是最不该靠人工核对的东西。
 * 注册完成后 `composition-root` 还会跑一次路由目录对账，漏注册与裸注册都会让启动失败。
 */
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
