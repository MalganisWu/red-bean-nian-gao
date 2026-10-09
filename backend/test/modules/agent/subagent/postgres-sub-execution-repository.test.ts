import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SqlExecutor, SqlQueryResult } from '../../../../src/infra/database/postgres.js'
import {
  SUB_EXECUTION_STORE_ERROR_CODES,
  SubExecutionStoreError,
  type SubExecutionRecord,
} from '../../../../src/modules/agent/subagent/model/sub-execution.js'
import { PostgresSubExecutionRepository } from '../../../../src/modules/agent/subagent/repository/adapter/postgres-sub-execution-repository.js'
import { runtimeState } from '../../../helpers/runtime-state.js'

class RecordingDatabase implements SqlExecutor {
  public readonly queries: { readonly sql: string; readonly parameters: readonly unknown[] }[] = []
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

const SIGNAL = AbortSignal.timeout(1_000)

void describe('PostgreSQL sub execution repository', () => {
  void it('claims pending recovery and returns the WAL after the revision fence', async () => {
    const database = new RecordingDatabase()
    database.results.push({
      rows: [
        subExecutionRow({
          revision: '4',
          recovery_messages: [{ role: 'assistant', content: '认领前已确认消息' }],
        }),
      ],
      rowCount: 1,
    })
    const repository = new PostgresSubExecutionRepository(database)

    const claimed = await repository.claimPending('SAEX_1', 3n, SIGNAL)

    assert.equal(claimed.revision, 4n)
    assert.deepEqual(claimed.recoveryMessages, [{ role: 'assistant', content: '认领前已确认消息' }])
    assert.match(database.queries[0]?.sql ?? '', /status = 'pending'/u)
    assert.match(database.queries[0]?.sql ?? '', /RETURNING[\s\S]*recovery_messages/u)
    assert.deepEqual(database.queries[0]?.parameters, ['SAEX_1', 3n])
  })

  void it('claims a resumable execution with revision and status CAS', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [{ revision: '4' }], rowCount: 1 })
    const repository = new PostgresSubExecutionRepository(database)
    const record = resumableRecord()
    record.status = 'running'

    const leaseExpiredBefore = new Date('2026-09-08T00:30:00.000Z')
    await repository.claimResume(record, leaseExpiredBefore, SIGNAL)

    assert.equal(record.revision, 4n)
    assert.match(database.queries[0]?.sql ?? '', /revision = revision \+ 1/u)
    assert.match(database.queries[0]?.sql ?? '', /revision = \$18/u)
    assert.match(database.queries[0]?.sql ?? '', /status IN \('interrupted', 'awaiting_user'\)/u)
    assert.deepEqual(database.queries[0]?.parameters.slice(-2), [3n, leaseExpiredBefore])
  })

  void it('reports a stale update as an explicit CAS conflict', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [], rowCount: 0 })
    const repository = new PostgresSubExecutionRepository(database)

    await assert.rejects(
      repository.update(resumableRecord(), SIGNAL),
      (error: unknown): boolean =>
        error instanceof SubExecutionStoreError &&
        error.code === SUB_EXECUTION_STORE_ERROR_CODES.REVISION_CONFLICT
    )
  })

  void it('renews only the current running revision owner', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 })
    const repository = new PostgresSubExecutionRepository(database)
    const renewedAt = new Date('2026-09-08T01:00:00.000Z')

    await repository.renewResumeLease('SAEX_1', 4n, renewedAt, SIGNAL)
    await assert.rejects(
      repository.renewResumeLease('SAEX_1', 3n, renewedAt, SIGNAL),
      (error: unknown): boolean =>
        error instanceof SubExecutionStoreError &&
        error.code === SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT
    )
    assert.match(database.queries[0]?.sql ?? '', /status = 'running'/u)
    assert.deepEqual(database.queries[0]?.parameters, [renewedAt, 'SAEX_1', 4n])
  })
})

function resumableRecord(): SubExecutionRecord {
  const now = new Date('2026-09-08T00:00:00.000Z')
  return {
    executionId: 'SAEX_1',
    sessionId: 'SESSION_1',
    requestId: 'REQUEST_1',
    agentId: 'AGENT_1',
    agentName: '测试 Agent',
    userId: 'USER_1',
    userMessage: '继续',
    display: [],
    recoveryMessages: [],
    runtimeState: runtimeState([{ role: 'user', content: '继续' }]),
    tokensUsed: 0,
    elapsedMilliseconds: 0,
    status: 'interrupted',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    revision: 3n,
  }
}

function subExecutionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date('2026-09-08T00:00:00.000Z')
  return {
    execution_id: 'SAEX_1',
    session_id: 'SESSION_1',
    request_id: 'REQUEST_1',
    agent_id: 'AGENT_1',
    agent_name: '测试 Agent',
    user_id: 'USER_1',
    user_message: '继续',
    system_prompt: null,
    display_messages: [],
    runtime_state: null,
    recovery_messages: [],
    model_name: null,
    tokens_used: 0,
    elapsed_ms: 0,
    status: 'pending',
    pending_interrupt_id: null,
    result_summary: null,
    error_msg: null,
    parent_call_id: null,
    created_at: now,
    updated_at: now,
    completed_at: now,
    revision: '3',
    ...overrides,
  }
}
