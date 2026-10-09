import type { SessionDetailDto, SessionSummaryDto } from './session.dto.js'

import type { DefaultSessionQueryService } from '../query/service/default-session-query-service.js'
import { SessionNotFoundError } from '../model/session.js'
import { loggedInternalError, notFoundError } from '../../../../shared/http/error-mapper.js'
import { toSessionDetailDto, toSessionSummaryDto } from './session-presenter.js'

/**
 * Session 查询用例的纯业务依赖。
 * 默认实现为 `DefaultSessionQueryService`（内部 1:1，无独立 Port），由 `agent.module.ts` 组装。
 */
export interface SessionControllerDependencies {
  readonly queries: DefaultSessionQueryService
}

/**
 * Session 查询的 HTTP 用例控制器：方法签名即"入参 + 返回"，不接触 Fastify 类型；负责 DTO 投影与应用错误映射。
 * 请求解包与成功信封输出由 `session.routes.ts` 承担。
 */
export class SessionController {
  readonly #dependencies: SessionControllerDependencies

  public constructor(dependencies: SessionControllerDependencies) {
    this.#dependencies = dependencies
  }

  public async list(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<{ readonly sessions: SessionSummaryDto[]; readonly next_cursor: string }> {
    try {
      const page = await this.#dependencies.queries.list({ userId, cursor, limit }, signal)
      return { sessions: page.sessions.map(toSessionSummaryDto), next_cursor: page.nextCursor }
    } catch (cause: unknown) {
      throw loggedInternalError('查询会话列表失败', cause)
    }
  }

  public async detail(
    userId: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<SessionDetailDto> {
    try {
      const session = await this.#dependencies.queries.detail({ sessionId, userId }, signal)
      return toSessionDetailDto(session)
    } catch (cause: unknown) {
      if (cause instanceof SessionNotFoundError) {
        throw notFoundError('会话不存在')
      }
      throw loggedInternalError('查询会话失败', cause)
    }
  }
}
