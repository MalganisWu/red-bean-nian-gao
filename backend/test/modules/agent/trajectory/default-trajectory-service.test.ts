import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DefaultTrajectoryService } from '../../../../src/modules/agent/trajectory/service/default-trajectory-service.js'
import type { SessionRepository } from '../../../../src/modules/agent/session/repository/port/session-repository.port.js'
import type {
  Session,
  SessionSummary,
} from '../../../../src/modules/agent/session/model/session.js'
import type { SubExecutionRecord } from '../../../../src/modules/agent/subagent/model/sub-execution.js'
import type { SubExecutionRepository } from '../../../../src/modules/agent/subagent/repository/port/sub-execution-repository.port.js'
import type { RunFactRepository } from '../../../../src/modules/agent/run-facts/port/run-fact-repository.port.js'
import { PostgresRunFactRepository } from '../../../../src/modules/agent/run-facts/adapter/postgres-run-fact-repository.js'
import type { SessionRunRecord } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import { SESSION_RUN_STATUSES } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import { RUN_FACT_SCHEMA_VERSION } from '../../../../src/modules/agent/run-facts/model/run-fact.js'
import type { SqlExecutor, SqlQueryResult } from '../../../../src/infra/database/postgres.js'

const STARTED_AT = 1_000_000

class StubSessionRepository implements SessionRepository {
  readonly #session: Session

  public constructor(session: Session) {
    this.#session = session
  }

  public getById(): Promise<Session> {
    return Promise.resolve(this.#session)
  }

  public getOrCreate(): Promise<Session> {
    return Promise.resolve(this.#session)
  }

  public save(): Promise<void> {
    return Promise.resolve()
  }

  public listByUser(): Promise<readonly SessionSummary[]> {
    return Promise.resolve([])
  }
}

class EmptySubExecutions implements SubExecutionRepository {
  public create(): Promise<void> {
    return Promise.resolve()
  }

  public getById(): Promise<SubExecutionRecord | undefined> {
    return Promise.resolve(undefined)
  }

  public listPending(): Promise<readonly SubExecutionRecord[]> {
    return Promise.resolve([])
  }

  public listBySession(): Promise<readonly SubExecutionRecord[]> {
    return Promise.resolve([])
  }

  public claimPending(): Promise<SubExecutionRecord> {
    return Promise.reject(new Error('轨迹查询不认领子执行'))
  }

  public claimResume(): Promise<void> {
    return Promise.resolve()
  }

  public renewResumeLease(): Promise<void> {
    return Promise.resolve()
  }

  public appendRecoveryMessage(): Promise<void> {
    return Promise.resolve()
  }

  public update(): Promise<void> {
    return Promise.resolve()
  }
}

class StubRunFactRepository implements RunFactRepository {
  readonly #runs: readonly SessionRunRecord[]

  public constructor(runs: readonly SessionRunRecord[]) {
    this.#runs = runs
  }

  public listBySession(): Promise<readonly SessionRunRecord[]> {
    return Promise.resolve(this.#runs)
  }

  public create(): Promise<SessionRunRecord> {
    return Promise.reject(new Error('轨迹查询不创建 run'))
  }

  public appendFact(): Promise<void> {
    return Promise.resolve()
  }

  public finalize(): Promise<void> {
    return Promise.resolve()
  }
}

const session: Session = {
  id: 'SESS_1',
  userId: 'USER_1',
  displayMessages: [
    { role: 'user', content: '旧会话消息', timestamp: STARTED_AT },
    {
      role: 'assistant',
      content: '旧回复',
      sections: [{ type: 'content', content: '旧回复', timestamp: STARTED_AT + 50 }],
      timestamp: STARTED_AT + 50,
    },
  ],
  revision: 0n,
  fencingToken: 0n,
}

const run: SessionRunRecord = {
  runId: 'RUN_1',
  sessionId: 'SESS_1',
  userId: 'USER_1',
  runIndex: 0,
  provider: 'openai',
  model: 'deepseek-chat',
  contextWindow: null,
  status: SESSION_RUN_STATUSES.COMPLETED,
  startedAt: STARTED_AT + 10_000,
  endedAt: STARTED_AT + 11_000,
  facts: [
    {
      type: 'user',
      content: '新一轮',
      at: STARTED_AT + 10_010,
      schemaVersion: RUN_FACT_SCHEMA_VERSION,
    },
    {
      type: 'assistant',
      at: STARTED_AT + 10_100,
      durationMs: 200,
      usage: { promptTokens: 12, completionTokens: 8, cacheReadTokens: null },
      attempts: [],
      thinking: '',
      content: '新回复',
      schemaVersion: RUN_FACT_SCHEMA_VERSION,
    },
  ],
  schemaVersion: 1,
}

const SIGNAL = new AbortController().signal

void describe('会话轨迹查询的数据源切换', () => {
  void it('keeps the display_messages projection for sessions without run records', async () => {
    const service = new DefaultTrajectoryService(
      new StubSessionRepository(session),
      new EmptySubExecutions(),
      new StubRunFactRepository([])
    )

    const view = await service.get({ sessionId: 'SESS_1', userId: 'USER_1' }, SIGNAL)

    assert.equal(view.totalTokens, null)
    assert.equal(view.turns[0]?.tokens, null)
    const step = view.turns[0]?.records.find((record): boolean => record.kind === 'call')
    assert.ok(step !== undefined)
    assert.equal(step.reply, '旧回复')
    assert.equal(step.tokens, null)
  })

  void it('serves token/request/terminal dimensions from the fact log when runs exist', async () => {
    const service = new DefaultTrajectoryService(
      new StubSessionRepository(session),
      new EmptySubExecutions(),
      new StubRunFactRepository([run])
    )

    const view = await service.get({ sessionId: 'SESS_1', userId: 'USER_1' }, SIGNAL)

    assert.equal(view.turns.length, 2)
    // 旧轮次保留 G0 回退语义；新轮次的 token 维度来自事实日志。
    assert.equal(view.turns[0]?.tokens, null)
    const factsTurn = view.turns[1]
    assert.ok(factsTurn !== undefined)
    assert.equal(factsTurn.tokens, 20)
    const step = factsTurn.records.find((record): boolean => record.kind === 'call')
    assert.ok(step !== undefined)
    assert.deepEqual(step.tokens, { input: 12, output: 8, cache: null })
    assert.equal(view.totalTokens, 20)
    assert.deepEqual(view.sessionEnd, { state: 'completed', at: STARTED_AT + 11_000 })
  })
})

class SingleRowDatabase implements SqlExecutor {
  readonly #row: unknown

  public constructor(row: unknown) {
    this.#row = row
  }

  public query(
    _sql: string,
    _parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    return Promise.resolve({ rows: [this.#row], rowCount: 1 })
  }
}

/**
 * 真实缺陷样本：facts 以轨迹 DTO 词汇手写（v 代替 schemaVersion、usage 用 input/output/cache、
 * attempt 是 "1/1" 字符串）。该行必须让轨迹查询降级为 G0 投影，而不是整页 500。
 */
const handWrittenRow = {
  run_id: 'run_demo1',
  session_id: 'SESS_1',
  user_id: 'USER_1',
  run_index: 0,
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  context_window: 128_000,
  status: 'completed',
  cancelled_at: null,
  cancelled_by: null,
  error: null,
  started_at: new Date(STARTED_AT + 10_000),
  ended_at: new Date(STARTED_AT + 20_000),
  header: null,
  facts: [
    { type: 'user', content: '帮我调研…', at: 1_789_089_731_000, v: 1 },
    {
      type: 'assistant',
      at: 1_789_089_731_000,
      durationMs: 4300,
      usage: { input: 3218, output: 412, cache: 0 },
      attempts: [
        {
          attempt: '1/1',
          durationMs: 4300,
          usage: { input: 3218, output: 412, cache: 0 },
          status: 'success',
        },
      ],
      thinking: '先分析需求',
      content: '',
      v: 1,
    },
    {
      type: 'tool',
      callId: 'c1',
      name: 'web_search',
      params: { query: '…' },
      result: '找到资料',
      startedAt: 1_789_089_732_000,
      durationMs: 1800,
      v: 1,
    },
  ],
  schema_version: 1,
}

class RecordingDegradationLogger {
  public readonly warnings: string[] = []

  public warn(message: string): void {
    this.warnings.push(message)
  }
}

void describe('会话轨迹查询对脏 facts 的降级', () => {
  void it('falls back to the display_messages projection when run facts are unreadable', async () => {
    // 走真实 PostgreSQL row → mapper → 事实校验的完整路径，复现手工插入脏 facts 行后的 GET /trajectory。
    const runFacts = new PostgresRunFactRepository(new SingleRowDatabase(handWrittenRow))
    const logger = new RecordingDegradationLogger()
    const service = new DefaultTrajectoryService(
      new StubSessionRepository(session),
      new EmptySubExecutions(),
      runFacts,
      logger
    )

    const view = await service.get({ sessionId: 'SESS_1', userId: 'USER_1' }, SIGNAL)

    // 回归：曾经整页 500（事实校验错误沿调用链上抛）；降级后历史轮次可见、token 维度未采集。
    assert.equal(view.turns.length, 1)
    assert.equal(view.totalTokens, null)
    const step = view.turns[0]?.records.find((record): boolean => record.kind === 'call')
    assert.ok(step !== undefined)
    assert.equal(step.reply, '旧回复')
    // G0 回退语义：终态由回复存在性推导。
    assert.deepEqual(view.sessionEnd, { state: 'completed', at: STARTED_AT + 50 })
    assert.equal(logger.warnings.length, 1)
    assert.match(logger.warnings[0] ?? '', /事实日志/u)
  })
})
