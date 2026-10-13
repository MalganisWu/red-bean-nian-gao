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
  /** 查询用例入口；控制器只用它读数据，不直接接触仓储。 */
  readonly queries: DefaultSessionQueryService
}

/**
 * Session 查询的 HTTP 用例控制器：方法签名即"入参 + 返回"，不接触 Fastify 类型；负责 DTO 投影与应用错误映射。
 * 请求解包与成功信封输出由 `session.routes.ts` 承担。
 */
export class SessionController {
  /** 注入的查询依赖；构造时固定，控制器自身无状态。 */
  readonly #dependencies: SessionControllerDependencies

  public constructor(dependencies: SessionControllerDependencies) {
    this.#dependencies = dependencies
  }

  /**
   * 列出当前用户的会话（游标分页）。
   *
   * 分片大小与游标由调用方先行规范化，本方法只把它们透传给用例；
   * 任何底层失败都折叠成一条对内可查日志、对外统一的 500，不把仓储细节透出。
   *
   * @param userId - 当前登录用户，决定可见范围；取自认证上下文而非请求体，避免越权。
   * @param cursor - 上一页末条的游标；空串表示取首页。
   * @param limit - 本页最大条数，调用方需已完成上限收敛。
   * @param signal - 请求取消信号，一路透传到仓储，客户端断开时中止查询。
   * @returns 本页摘要列表与下一页游标；游标为空串表示已到末页。
   */
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

  /**
   * 读取单个会话详情。
   *
   * 会话不存在与不属于当前用户收敛到同一条 404，调用方无法靠状态码探出他人会话是否存在；
   * 其余失败走 500。
   *
   * @param userId - 当前登录用户，用于归属校验。
   * @param sessionId - 目标会话标识；越权与不存在都会得到 404。
   * @param signal - 请求取消信号，客户端断开时中止查询。
   * @returns 会话详情 DTO。
   */
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
