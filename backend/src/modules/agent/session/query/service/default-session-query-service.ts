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

  /**
   * 按用户列出会话摘要。
   *
   * 结果条数恰好等于请求的 limit 时才给出下一页游标——少一条就说明后面没有了，
   * 此时给游标会让调用方多发一次注定为空的请求。
   *
   * @param query - 列表查询入参；`cursor` 空串表示首页。
   * @param signal - 取消信号，透传到仓储。
   * @returns 本页摘要与下一页游标，末页时游标为空串。
   */
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

  /**
   * 读取单个会话聚合。
   *
   * 把仓储的 `NOT_FOUND` 翻译成语用层的 `SessionNotFoundError`：越权与不存在在仓储层
   * 已是同一条错误，这里保持同一分支，Controller 才好统一映射成 404。
   *
   * @param query - 详情查询入参，必须同时带 `sessionId` 与 `userId`。
   * @param signal - 取消信号，透传到仓储。
   * @returns 目标会话聚合；不存在或不属于该用户时抛 `SessionNotFoundError`。
   */
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
