import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PostgresRunFactRepository } from '../../../../src/modules/agent/run-facts/adapter/postgres-run-fact-repository.js'
import {
  RUN_FACT_SCHEMA_VERSION,
  type RunAssistantFact,
  type RunUserFact,
} from '../../../../src/modules/agent/run-facts/model/run-fact.js'
import {
  SESSION_RUN_CANCELLED_BY,
  SESSION_RUN_STATUSES,
  type StartSessionRunCommand,
} from '../../../../src/modules/agent/run-facts/model/session-run.js'
import type { SqlExecutor, SqlQueryResult } from '../../../../src/infra/database/postgres.js'

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

const startCommand: StartSessionRunCommand = {
  runId: 'RUN_1',
  sessionId: 'SESSION_1',
  userId: 'USER_1',
  provider: 'openai',
  model: 'deepseek-chat',
  contextWindow: 131_072,
  startedAt: Date.parse('2026-09-11T08:00:00.000Z'),
}

void describe('PostgreSQL run fact repository', () => {
  void it('creates a running run container with a session-scoped run_index', async () => {
    const database = new RecordingDatabase()
    database.results.push({
      rows: [{ run_index: 2, created_at: new Date(), updated_at: new Date() }],
      rowCount: 1,
    })
    const repository = new PostgresRunFactRepository(database)

    const record = await repository.create(startCommand, AbortSignal.timeout(1_000))

    assert.equal(record.runIndex, 2)
    assert.equal(record.status, SESSION_RUN_STATUSES.RUNNING)
    assert.deepEqual(record.facts, [])
    const sql = database.queries[0]?.sql ?? ''
    assert.match(sql, /COALESCE\(MAX\(run_index\) \+ 1, 0\)/u)
    assert.match(sql, /WHERE session_id = \$2/u)
    assert.match(sql, /'running'/u)
    assert.deepEqual(database.queries[0]?.parameters, [
      'RUN_1',
      'SESSION_1',
      'USER_1',
      'openai',
      'deepseek-chat',
      131_072,
      new Date(startCommand.startedAt),
      null,
      1,
    ])
  })

  void it('appends a fact as JSONB onto a running run only', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [], rowCount: 1 })
    const repository = new PostgresRunFactRepository(database)
    const fact: RunUserFact = {
      type: 'user',
      content: '开始',
      at: 1_000,
      schemaVersion: RUN_FACT_SCHEMA_VERSION,
    }

    await repository.appendFact('RUN_1', fact, AbortSignal.timeout(1_000))

    const sql = database.queries[0]?.sql ?? ''
    assert.match(sql, /facts = facts \|\| \$2::jsonb/u)
    assert.match(sql, /WHERE run_id = \$1 AND ended_at IS NULL/u)
    assert.equal(database.queries[0]?.parameters[0], 'RUN_1')
    assert.deepEqual(JSON.parse(String(database.queries[0]?.parameters[1])), fact)
  })

  void it('rejects appending facts to a finished or missing run', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [], rowCount: 0 })
    const repository = new PostgresRunFactRepository(database)

    await assert.rejects(
      repository.appendFact(
        'RUN_1',
        { type: 'user', content: '开始', at: 1, schemaVersion: RUN_FACT_SCHEMA_VERSION },
        AbortSignal.timeout(1_000)
      ),
      /已终态/u
    )
  })

  void it('finalizes with terminal status, cancel attribution and error once', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [], rowCount: 1 })
    const repository = new PostgresRunFactRepository(database)

    await repository.finalize(
      'RUN_1',
      {
        status: SESSION_RUN_STATUSES.CANCELLED,
        endedAt: Date.parse('2026-09-11T08:00:10.000Z'),
        cancelledAt: Date.parse('2026-09-11T08:00:10.000Z'),
        cancelledBy: SESSION_RUN_CANCELLED_BY.USER,
      },
      AbortSignal.timeout(1_000)
    )

    const sql = database.queries[0]?.sql ?? ''
    assert.match(sql, /SET status = \$2/u)
    assert.match(sql, /cancelled_at = \$4/u)
    assert.match(sql, /cancelled_by = \$5/u)
    assert.match(sql, /WHERE run_id = \$1 AND ended_at IS NULL/u)
    assert.deepEqual(database.queries[0]?.parameters, [
      'RUN_1',
      'cancelled',
      new Date(Date.parse('2026-09-11T08:00:10.000Z')),
      new Date(Date.parse('2026-09-11T08:00:10.000Z')),
      'user',
      null,
    ])
  })

  void it('maps a persisted row back into the session run record', async () => {
    const database = new RecordingDatabase()
    const fact: RunAssistantFact = {
      type: 'assistant',
      at: 1_500,
      durationMs: 200,
      usage: { promptTokens: 10, completionTokens: 4, cacheReadTokens: null },
      attempts: [],
      thinking: '',
      content: '完成',
      schemaVersion: RUN_FACT_SCHEMA_VERSION,
    }
    database.results.push({
      rows: [
        {
          run_id: 'RUN_1',
          session_id: 'SESSION_1',
          user_id: 'USER_1',
          run_index: 0,
          provider: 'openai',
          model: 'deepseek-chat',
          context_window: null,
          status: 'completed',
          cancelled_at: null,
          cancelled_by: null,
          error: null,
          started_at: new Date(startCommand.startedAt),
          ended_at: new Date(Date.parse('2026-09-11T08:00:12.000Z')),
          header: null,
          facts: [fact],
          schema_version: 1,
        },
      ],
      rowCount: 1,
    })
    const repository = new PostgresRunFactRepository(database)

    const records = await repository.listBySession('SESSION_1', AbortSignal.timeout(1_000))

    assert.match(database.queries[0]?.sql ?? '', /ORDER BY run_index ASC/u)
    assert.equal(records.length, 1)
    const record = records[0]
    assert.ok(record !== undefined)
    assert.equal(record.startedAt, startCommand.startedAt)
    assert.equal(record.endedAt, Date.parse('2026-09-11T08:00:12.000Z'))
    assert.equal(record.status, SESSION_RUN_STATUSES.COMPLETED)
    assert.equal(record.facts[0]?.type, 'assistant')
  })

  void it('wraps storage failures with a Chinese diagnostic and cause chain', async () => {
    const failing: SqlExecutor = {
      query: (): Promise<SqlQueryResult> => Promise.reject(new Error('connection refused')),
    }
    const repository = new PostgresRunFactRepository(failing)

    await assert.rejects(
      repository.create(startCommand, AbortSignal.timeout(1_000)),
      /创建 session run 容器失败 \(RUN_1\)：connection refused/u
    )
  })
})
