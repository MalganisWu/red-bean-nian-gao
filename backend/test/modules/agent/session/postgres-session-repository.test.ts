import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PostgresSessionRepository } from '../../../../src/modules/agent/session/repository/adapter/postgres-session-repository.js'
import {
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
  type Session,
} from '../../../../src/modules/agent/session/model/session.js'
import type { SqlExecutor, SqlQueryResult } from '../../../../src/infra/database/postgres.js'
import { runtimeState } from '../../../helpers/runtime-state.js'

interface RecordedQuery {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

class RecordingDatabase implements SqlExecutor {
  public readonly queries: RecordedQuery[] = []
  public readonly results: SqlQueryResult[] = []

  public query(
    sql: string,
    parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    this.queries.push({ sql, parameters })
    return Promise.resolve(this.results.shift() ?? { rows: [], rowCount: 0 })
  }
}

const updatedAt = new Date('2026-09-04T12:00:00.000Z')
const sessionRow = {
  session_id: 'SESSION_1',
  user_id: 'USER_1',
  runtime_state: runtimeState([{ role: 'user', content: '你好' }]),
  display_messages: [{ role: 'user', content: '你好', timestamp: 1 }],
  revision: '2',
  fencing_token: '7',
  updated_at: updatedAt,
}

void describe('PostgreSQL session repository', () => {
  void it('maps an owned session and hides an ownership mismatch as not found', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [sessionRow], rowCount: 1 }, { rows: [], rowCount: 0 })
    const repository = new PostgresSessionRepository(database)
    const signal = AbortSignal.timeout(1_000)

    assert.deepEqual(await repository.getById('SESSION_1', 'USER_1', signal), {
      id: 'SESSION_1',
      userId: 'USER_1',
      runtimeState: runtimeState([{ role: 'user', content: '你好' }]),
      displayMessages: [{ role: 'user', content: '你好', timestamp: 1 }],
      revision: 2n,
      fencingToken: 7n,
    })
    await assert.rejects(
      repository.getById('SESSION_1', 'USER_2', signal),
      isSessionError(SESSION_STORE_ERROR_CODES.NOT_FOUND)
    )
    assert.match(database.queries[0]?.sql ?? '', /WHERE session_id = \$1 AND user_id = \$2/u)
  })

  // 存量会话行的 display_messages 仍带已删除的 `think` / `steps`。schema 非 strict，必须 strip 而非
  // 解析失败，否则老库一读就抛 invalid session row。R25 明确要求的回归覆盖。
  void it('loads a legacy row whose display messages still carry think and steps', async () => {
    const database = new RecordingDatabase()
    database.results.push({
      rows: [
        {
          ...sessionRow,
          display_messages: [
            {
              role: 'assistant',
              content: '旧格式回答',
              timestamp: 2,
              think: [{ content: '旧推理', timestamp: 1 }],
              steps: [{ type: 'process', items: [] }],
            },
          ],
        },
      ],
      rowCount: 1,
    })
    const repository = new PostgresSessionRepository(database)

    const session = await repository.getById('SESSION_1', 'USER_1', AbortSignal.timeout(1_000))

    assert.deepEqual(session.displayMessages, [
      { role: 'assistant', content: '旧格式回答', timestamp: 2 },
    ])
  })

  void it('creates a missing session without taking over an existing foreign ID', async () => {
    const database = new RecordingDatabase()
    database.results.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ user_id: 'OTHER' }], rowCount: 1 }
    )
    const repository = new PostgresSessionRepository(database)
    const signal = AbortSignal.timeout(1_000)

    assert.deepEqual(await repository.getOrCreate('NEW', 'USER_1', signal), {
      id: 'NEW',
      userId: 'USER_1',
      displayMessages: [],
      revision: 0n,
      fencingToken: 0n,
    })
    await assert.rejects(
      repository.getOrCreate('TAKEN', 'USER_1', signal),
      isSessionError(SESSION_STORE_ERROR_CODES.NOT_FOUND)
    )
  })

  void it('saves with revision and fencing CAS and updates the in-memory revision', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [{ revision: '3' }], rowCount: 1 })
    const repository = new PostgresSessionRepository(database)
    const session: Session = {
      id: 'SESSION_1',
      userId: 'USER_1',
      runtimeState: runtimeState([{ role: 'assistant', content: '完成' }]),
      displayMessages: [{ role: 'assistant', content: '完成', timestamp: 2 }],
      revision: 2n,
      fencingToken: 7n,
    }

    await repository.save(session, AbortSignal.timeout(1_000))

    assert.equal(session.revision, 3n)
    assert.match(database.queries[0]?.sql ?? '', /revision = revision \+ 1/u)
    assert.match(database.queries[0]?.sql ?? '', /fencing_token = \$4/u)
    assert.deepEqual(database.queries[0]?.parameters.slice(2), [2n, 7n, 'SESSION_1', 'USER_1'])
  })

  void it('classifies failed writes and advances the shared fencing sequence', async () => {
    const database = new RecordingDatabase()
    database.results.push(
      { rows: [], rowCount: 0 },
      { rows: [{ user_id: 'USER_1', revision: '3', fencing_token: '8' }], rowCount: 1 },
      { rows: [{ token: '42' }], rowCount: 1 }
    )
    const repository = new PostgresSessionRepository(database)
    const session: Session = {
      id: 'SESSION_1',
      userId: 'USER_1',
      displayMessages: [],
      revision: 2n,
      fencingToken: 7n,
    }

    await assert.rejects(
      repository.save(session, AbortSignal.timeout(1_000)),
      isSessionError(SESSION_STORE_ERROR_CODES.STALE_FENCE)
    )
    assert.equal(await repository.nextFencingToken(AbortSignal.timeout(1_000)), 42n)
  })

  void it('lists summaries with the existing timestamp cursor contract', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [sessionRow], rowCount: 1 })
    const repository = new PostgresSessionRepository(database)

    assert.deepEqual(
      await repository.listByUser(
        'USER_1',
        '2026-09-04T13:00:00.000Z',
        20,
        AbortSignal.timeout(1_000)
      ),
      [{ id: 'SESSION_1', title: '你好', messageCount: 1, updatedAt }]
    )
    assert.match(database.queries[0]?.sql ?? '', /updated_at < \$2/u)
    assert.deepEqual(database.queries[0]?.parameters, [
      'USER_1',
      new Date('2026-09-04T13:00:00.000Z'),
      20,
    ])
  })
})

function isSessionError(
  code: (typeof SESSION_STORE_ERROR_CODES)[keyof typeof SESSION_STORE_ERROR_CODES]
): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof SessionStoreError && error.code === code
}
