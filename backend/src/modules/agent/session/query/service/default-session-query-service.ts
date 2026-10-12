import {
  SESSION_STORE_ERROR_CODES,
  SessionNotFoundError,
  SessionStoreError,
  type Session,
} from '../../model/session.js'
import type { SessionRepository } from '../../repository/port/session-repository.port.js'
import type { SessionSummary } from '../../model/session.js'

/** 会话列表查询入参；`cursor` 为空串表示取首页。 */
export interface ListSessionsQuery {
  readonly userId: string
  readonly cursor: string
  readonly limit: number
}

/** 会话列表结果；`nextCursor` 为空串表示没有下一页。 */
export interface SessionQueryPage {
  readonly sessions: readonly SessionSummary[]
  readonly nextCursor: string
}

/** 详情查询入参；必须同时带 userId，越权访问与不存在因此收敛到同一条 404 分支。 */
export interface GetSessionQuery {
  readonly sessionId: string
  readonly userId: string
}

/**
 * Session 查询用例，内部 1:1 实现（无独立 Port），由 `agent.module.ts` 组装，
 * Controller 直接依赖本类。列表与详情查询可在各公开方法内一次读完。
 */
export class DefaultSessionQueryService {
  readonly #repository: SessionRepository

  public constructor(repository: SessionRepository) {
    this.#repository = repository
  }

  public async list(query: ListSessionsQuery, signal: AbortSignal): Promise<SessionQueryPage> {
    const sessions = await this.#repository.listByUser(
      query.userId,
      query.cursor,
      query.limit,
      signal
    )
    const last = sessions.at(-1)
    return {
      sessions,
      nextCursor:
        sessions.length === query.limit && last !== undefined ? last.updatedAt.toISOString() : '',
    }
  }

  public async detail(query: GetSessionQuery, signal: AbortSignal): Promise<Session> {
    try {
      return await this.#repository.getById(query.sessionId, query.userId, signal)
    } catch (cause: unknown) {
      if (
        cause instanceof SessionStoreError &&
        cause.code === SESSION_STORE_ERROR_CODES.NOT_FOUND
      ) {
        throw new SessionNotFoundError({ cause })
      }
      throw cause
    }
  }
}
