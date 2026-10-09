import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SESSION_STORE_ERROR_CODES,
  SessionNotFoundError,
  SessionStoreError,
  type Session,
  type SessionSummary,
} from '../../../../../src/modules/agent/session/model/session.js'
import type { SessionRepository } from '../../../../../src/modules/agent/session/repository/port/session-repository.port.js'
import {
  DefaultSessionQueryService,
  type ListSessionsQuery,
} from '../../../../../src/modules/agent/session/query/service/default-session-query-service.js'

const SIGNAL = new AbortController().signal

class QuerySessionRepository implements SessionRepository {
  public summaries: readonly SessionSummary[] = []
  public session: Session | undefined

  public getOrCreate(): Promise<Session> {
    return Promise.reject(new Error('not used'))
  }

  public getById(): Promise<Session> {
    return this.session === undefined
      ? Promise.reject(
          new SessionStoreError(SESSION_STORE_ERROR_CODES.NOT_FOUND, 'session not found')
        )
      : Promise.resolve(structuredClone(this.session))
  }

  public save(): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  public listByUser(): Promise<readonly SessionSummary[]> {
    return Promise.resolve(structuredClone(this.summaries))
  }
}

void describe('DefaultSessionQueryService', () => {
  void it('在满页时返回最后更新时间作为下一页游标', async () => {
    const repository = new QuerySessionRepository()
    repository.summaries = [
      { id: 'SESSION_1', title: '会话', messageCount: 2, updatedAt: new Date('2026-09-08Z') },
    ]
    const query: ListSessionsQuery = { userId: 'USER_1', cursor: '', limit: 1 }

    const page = await new DefaultSessionQueryService(repository).list(query, SIGNAL)

    assert.deepEqual(page.sessions, repository.summaries)
    assert.equal(page.nextCursor, '2026-09-08T00:00:00.000Z')
  })

  void it('把仓储不存在错误转换成稳定的应用错误', async () => {
    const service = new DefaultSessionQueryService(new QuerySessionRepository())

    await assert.rejects(
      service.detail({ sessionId: 'missing', userId: 'USER_1' }, SIGNAL),
      SessionNotFoundError
    )
  })
})
