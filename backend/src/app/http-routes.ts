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

/** 各 Module 输出的路由依赖绑定表；这里只出现 Port 与路由依赖类型，不出现任何实现类。 */
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
 *
 * 注册只在启动期发生一次，此后路由表封闭；运行期不再追加或替换路由，
 * 因此这里收到的依赖绑定表一旦传入就不应再变。
 * @param server - 目标 Fastify 实例；本函数只做注册，不负责监听与关闭
 * @param dependencies - 各 Module 输出的 Port 绑定表；实现类不得出现在这里
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
