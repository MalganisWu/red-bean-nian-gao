import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { IdGenerator } from '../../../../../src/shared/id/id-generator.js'

import { createHttpServer } from '../../../../../src/shared/http/fastify-http-boundary.js'
import { registerSessionRoutes } from '../../../../../src/modules/agent/http-api.js'
import {
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
  type Session,
  type SessionSummary,
} from '../../../../../src/modules/agent/session/model/session.js'
import type { SessionRepository } from '../../../../../src/modules/agent/session/repository/port/session-repository.port.js'
import { DefaultSessionQueryService } from '../../../../../src/modules/agent/session/query/service/default-session-query-service.js'
import type { AuthServicePort } from '../../../../../src/modules/identity/service/authentication/port/auth-service.port.js'

class FixedIds implements IdGenerator {
  public generate(prefix: string): string {
    return `${prefix}_1`
  }
}

class TestAuth implements AuthServicePort {
  public login(): Promise<string> {
    return Promise.resolve('token')
  }
  public logout(): Promise<void> {
    return Promise.resolve()
  }
  public validateToken(): Promise<string> {
    return Promise.resolve('USER_1')
  }
  public refreshToken(): Promise<string> {
    return Promise.resolve('token')
  }
}

class TestSessions implements SessionRepository {
  public summaries: readonly SessionSummary[] = []
  public session: Session | undefined

  public getOrCreate(): Promise<Session> {
    return Promise.reject(new Error('not used'))
  }

  public getById(sessionId: string, userId: string): Promise<Session> {
    if (
      this.session === undefined ||
      this.session.id !== sessionId ||
      this.session.userId !== userId
    ) {
      return Promise.reject(
        new SessionStoreError(SESSION_STORE_ERROR_CODES.NOT_FOUND, 'session not found')
      )
    }
    return Promise.resolve(structuredClone(this.session))
  }

  public save(): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  public listByUser(): Promise<readonly SessionSummary[]> {
    return Promise.resolve(structuredClone(this.summaries))
  }
}

async function buildServer(repository: SessionRepository) {
  const server = createHttpServer({ idGenerator: new FixedIds() })
  registerSessionRoutes(server, {
    queries: new DefaultSessionQueryService(repository),
    authService: new TestAuth(),
  })
  await server.ready()
  return server
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function sessionDetailContractGolden(): Promise<Readonly<Record<string, unknown>>> {
  const document = await readFile(path.resolve(process.cwd(), '../docs/contracts/api.md'), 'utf8')
  const startMarker = '<!-- SESSION-DETAIL-GOLDEN-START -->'
  const endMarker = '<!-- SESSION-DETAIL-GOLDEN-END -->'
  const start = document.indexOf(startMarker)
  const end = document.indexOf(endMarker)
  assert.ok(start >= 0 && end > start, 'missing SESSION-DETAIL-GOLDEN markers')
  const json = document
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/^```json\s*/u, '')
    .replace(/\s*```$/u, '')
  const parsed: unknown = JSON.parse(json)
  assert.ok(isRecord(parsed))
  return parsed
}

void describe('Fastify session route parity', () => {
  void it('lists snake-case summaries and advances the timestamp cursor on a full page', async () => {
    const repository = new TestSessions()
    repository.summaries = [
      {
        id: 'SESSION_1',
        title: '你好',
        messageCount: 2,
        updatedAt: new Date('2026-09-04T12:00:00.123456Z'),
      },
    ]
    const server = await buildServer(repository)

    const response = await server.inject({
      method: 'GET',
      url: '/api/sessions?limit=1',
      headers: { authorization: 'Bearer token' },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      code: 200,
      data: {
        sessions: [
          {
            id: 'SESSION_1',
            title: '你好',
            message_count: 2,
            updated_at: '2026-09-04T12:00:00.123Z',
          },
        ],
        next_cursor: '2026-09-04T12:00:00.123Z',
      },
    })
    await server.close()
  })

  void it('returns only public display messages from an owned session', async () => {
    const golden = await sessionDetailContractGolden()
    const repository = new TestSessions()
    repository.session = {
      id: 'SESSION_1',
      userId: 'USER_1',
      displayMessages: [
        { role: 'user', content: '你好', timestamp: 1000 },
        {
          role: 'assistant',
          sections: [
            {
              type: 'tool_group',
              tools: [
                {
                  callId: 'call_1',
                  name: 'calc',
                  status: 'success',
                  result: '42',
                  duration: 1234,
                },
              ],
              timestamp: 1500,
            },
            { type: 'content', content: '世界', timestamp: 2000, duration: 10 },
          ],
          timestamp: 2000,
        },
      ],
      revision: 2n,
      fencingToken: 3n,
    }
    const server = await buildServer(repository)

    const response = await server.inject({
      method: 'GET',
      url: '/api/sessions/SESSION_1',
      headers: { authorization: 'Bearer token' },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { code: 200, data: golden })
    assert.equal(response.body.includes('private prompt'), false)
    await server.close()
  })

  void it('hides missing sessions and rejects unauthenticated access', async () => {
    const server = await buildServer(new TestSessions())
    const missing = await server.inject({
      method: 'GET',
      url: '/api/sessions/missing',
      headers: { authorization: 'Bearer token' },
    })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { code: 4004, message: '会话不存在', data: null })

    const anonymous = await server.inject({ method: 'GET', url: '/api/sessions' })
    assert.equal(anonymous.statusCode, 401)
    await server.close()
  })
})
