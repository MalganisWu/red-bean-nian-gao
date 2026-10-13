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
  /** 轨迹查询用例；控制器只读它，不开启任何写路径。 */
  readonly trajectory: DefaultTrajectoryService
}

/**
 * 会话轨迹的 HTTP 用例控制器：入参标量 + 返回 wire DTO，不接触 Fastify 类型；
 * 负责 wire 投影与应用错误映射。请求解包与成功信封由 `trajectory.routes.ts` 承担。
 */
export class TrajectoryController {
  /** 控制器依赖，构造期一次性注入；装配入口在 `agent.module.ts`。 */
  readonly #dependencies: TrajectoryControllerDependencies

  public constructor(dependencies: TrajectoryControllerDependencies) {
    this.#dependencies = dependencies
  }

  /**
   * 查询会话轨迹；会话不存在映射为 404 应用错误，其余失败折叠为统一 500 并记录诊断。
   *
   * @param userId - 当前登录用户，决定归属范围；越权与不存在收敛到同一条 404。
   * @param sessionId - 目标会话标识，取自路径参数且已过契约校验。
   * @param signal - 请求取消信号，透传到仓储，客户端断开时中止查询。
   * @returns 轨迹 wire DTO；投影口径由服务层决定，本层不做二次加工。
   */
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
