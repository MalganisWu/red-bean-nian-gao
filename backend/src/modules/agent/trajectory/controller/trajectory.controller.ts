import type { SessionTrajectoryDto } from '@red-bean/api-contract'

import { loggedInternalError, notFoundError } from '../../../../shared/http/error-mapper.js'
import { SessionNotFoundError } from '../../session/model/session.js'
import type { DefaultTrajectoryService } from '../service/default-trajectory-service.js'
import { toSessionTrajectoryDto } from './trajectory-presenter.js'

/**
 * Trajectory 查询的纯业务依赖。
 * 默认实现为 `DefaultTrajectoryService`（内部 1:1，无独立 Port），由 `agent.module.ts` 组装。
 */
export interface TrajectoryControllerDependencies {
  readonly trajectory: DefaultTrajectoryService
}

/**
 * 会话轨迹的 HTTP 用例控制器：入参标量 + 返回 wire DTO，不接触 Fastify 类型；
 * 负责 wire 投影与应用错误映射。请求解包与成功信封由 `trajectory.routes.ts` 承担。
 */
export class TrajectoryController {
  readonly #dependencies: TrajectoryControllerDependencies

  public constructor(dependencies: TrajectoryControllerDependencies) {
    this.#dependencies = dependencies
  }

  /** 查询会话轨迹；会话不存在映射为 404 应用错误。 */
  public async get(
    userId: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<SessionTrajectoryDto> {
    try {
      const view = await this.#dependencies.trajectory.get({ sessionId, userId }, signal)
      return toSessionTrajectoryDto(view)
    } catch (cause: unknown) {
      if (cause instanceof SessionNotFoundError) {
        throw notFoundError('会话不存在')
      }
      throw loggedInternalError('查询会话轨迹失败', cause)
    }
  }
}
