import assert from 'node:assert/strict'
import type { User } from '../../src/modules/identity/model/user.js'
import { PostgresUserRepository } from '../../src/modules/identity/service/user-repository/postgres-user-repository.js'
import { UserRepositoryConflictError } from '../../src/modules/identity/service/user-repository/port/user-repository.port.js'
import type { AgentTaskDefinition, AgentTaskExecution } from '../../src/modules/task/model/task.js'
import { TestPostgresTaskRepositories as PostgresTaskRepository } from '../helpers/postgres-task-repositories.js'
import { type PostgresDatabase } from '../../src/infra/database/postgres.js'
import type { SubExecutionRecord } from '../../src/modules/agent/subagent/model/sub-execution.js'
import { PostgresRunFactRepository } from '../../src/modules/agent/run-facts/adapter/postgres-run-fact-repository.js'
import {
  RUN_FACT_SCHEMA_VERSION,
  type RunAssistantFact,
  type RunCompactionFact,
  type RunUserFact,
} from '../../src/modules/agent/run-facts/model/run-fact.js'
import {
  SESSION_RUN_CANCELLED_BY,
  SESSION_RUN_STATUSES,
} from '../../src/modules/agent/run-facts/model/session-run.js'
import { stringField } from './integration-environment-test-support.js'

export const EXPECTED_TABLES = [
  'agent_task_executions',
  'api_credentials',
  'bun_migration_locks',
  'bun_migrations',
  'core_agents',
  'llm_configs',
  'mcp_servers',
  'scheduled_tasks',
  'service_tools',
  'session_runs',
  'sessions',
  'sub_agent_executions',
  'system_tools',
  'task_run_view_states',
  'users',
] as const

export async function verifyUserRoundTrip(
  database: PostgresDatabase,
  signal: AbortSignal
): Promise<void> {
  const repository = new PostgresUserRepository(database)
  const timestamp = new Date('2026-09-04T00:00:00.000Z')
  const concurrentUser = (id: string): User => ({
    id,
    username: 'concurrent-user',
    email: 'concurrent@example.com',
    passwordHash: '$2b$10$concurrent',
    displayName: 'Concurrent',
    avatar: undefined,
    isActive: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  const concurrentAttempts = await Promise.allSettled([
    repository.create(concurrentUser('USER_CONCURRENT_A'), signal),
    repository.create(concurrentUser('USER_CONCURRENT_B'), signal),
  ])
  assert.equal(
    concurrentAttempts.filter((attempt): boolean => attempt.status === 'fulfilled').length,
    1
  )
  const conflict = concurrentAttempts.find((attempt): boolean => attempt.status === 'rejected')
  assert.ok(conflict !== undefined && conflict.status === 'rejected')
  assert.ok(conflict.reason instanceof UserRepositoryConflictError)
  await database.query("DELETE FROM users WHERE username = 'concurrent-user'", [], signal)

  const user: User = {
    id: 'USER_INTEGRATION',
    username: 'integration-user',
    email: 'before@example.com',
    passwordHash: '$2b$10$integration',
    displayName: 'Before',
    avatar: undefined,
    isActive: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  await repository.create(user, signal)
  assert.deepEqual(await repository.getById(user.id, signal), user)
  user.email = 'after@example.com'
  user.displayName = 'After'
  await repository.update(user, signal)
  assert.equal((await repository.getByEmail(user.email, signal))?.displayName, 'After')
  assert.equal((await repository.list(0, 10, signal)).total, 1)
  await repository.delete(user.id, signal)
  assert.equal((await repository.list(0, 10, signal)).total, 0)
}

export async function verifyTaskRoundTrip(
  database: PostgresDatabase,
  signal: AbortSignal
): Promise<void> {
  const repository = new PostgresTaskRepository(database)
  const scheduledAt = new Date('2026-09-04T08:00:00.000Z')
  const task: AgentTaskDefinition = {
    taskId: 'STASK_INTEGRATION',
    userId: 'USER_INTEGRATION',
    sessionId: 'SESS_INTEGRATION',
    taskInput: '整理今天的项目进展',
    runAt: scheduledAt,
    cronExpr: '',
    scheduleType: 'once',
    isActive: true,
    retryCount: 0,
    nextRunAt: scheduledAt,
  }
  const execution: AgentTaskExecution = {
    executionId: 'TAEX_INTEGRATION',
    taskId: task.taskId,
    sessionId: task.sessionId,
    status: 'completed',
    scheduledAt,
    startedAt: scheduledAt,
    completedAt: new Date('2026-09-04T08:00:02.000Z'),
    displayMessages: [{ role: 'assistant', content: '项目进展已整理', timestamp: 1 }],
    resultType: 'text',
    resultMessage: '项目进展已整理',
    delivered: false,
  }

  await database.query(
    `INSERT INTO sessions (session_id, user_id, display_messages)
     VALUES ($1, $2, $3::jsonb)`,
    [
      task.sessionId,
      task.userId,
      JSON.stringify([{ role: 'user', content: '真实数据库任务会话', timestamp: 1 }]),
    ],
    signal
  )
  await repository.createTask(task, signal)
  assert.deepEqual(await repository.getTask(task.taskId, signal), task)
  assert.equal((await repository.getPendingTasks(scheduledAt, 10, signal)).length, 1)

  const completedTask: AgentTaskDefinition = {
    ...task,
    isActive: false,
    retryCount: 1,
    nextRunAt: undefined,
  }
  await repository.saveExecutionWithTaskUpdate(completedTask, execution, signal)
  assert.equal((await repository.getTask(task.taskId, signal)).isActive, false)
  assert.equal((await repository.listExecutions(task.taskId, '', 10, signal)).items.length, 1)
  assert.equal(
    (await repository.listItemsByUser(task.userId, '', 10, signal)).items[0]?.sessionTitle,
    '真实数据库任务会话'
  )

  const initialStates = await repository.listExecutionViewStates(
    task.userId,
    [execution.executionId],
    signal
  )
  assert.deepEqual(initialStates, [{ executionId: execution.executionId }])
  const state = await repository.upsertExecutionViewState(
    task.userId,
    execution.executionId,
    true,
    false,
    signal
  )
  assert.ok(state.seenAt instanceof Date)
  assert.equal(state.collapsedOverride, false)
  assert.equal(await repository.markExecutionDelivered(execution.executionId, signal), true)
  assert.equal(await repository.markExecutionDelivered(execution.executionId, signal), false)
  assert.equal((await repository.listUndeliveredExecutions(task.sessionId, signal)).length, 0)
}

/** session_runs 事实日志的真实 PostgreSQL 往返：run_index 分配、facts 追加、终态 CAS、会话读取。 */
export async function verifySessionRunRoundTrip(
  database: PostgresDatabase,
  signal: AbortSignal
): Promise<void> {
  const repository = new PostgresRunFactRepository(database)
  const startedAt = Date.parse('2026-09-11T08:00:00.000Z')

  const first = await repository.create(
    {
      runId: 'RUN_FACT_A',
      sessionId: 'SESS_FACT',
      userId: 'USER_INTEGRATION',
      provider: 'openai',
      model: 'deepseek-chat',
      contextWindow: null,
      startedAt,
    },
    signal
  )
  assert.equal(first.runIndex, 0)
  const second = await repository.create(
    {
      runId: 'RUN_FACT_B',
      sessionId: 'SESS_FACT',
      userId: 'USER_INTEGRATION',
      provider: 'openai',
      model: 'deepseek-chat',
      contextWindow: 131_072,
      startedAt: startedAt + 60_000,
    },
    signal
  )
  assert.equal(second.runIndex, 1)

  const userFact: RunUserFact = {
    type: 'user',
    content: '真实数据库事实',
    at: startedAt + 10,
    schemaVersion: RUN_FACT_SCHEMA_VERSION,
  }
  const assistantFact: RunAssistantFact = {
    type: 'assistant',
    at: startedAt + 120,
    durationMs: 110,
    usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: null },
    attempts: [],
    thinking: '分析',
    content: '完成',
    schemaVersion: RUN_FACT_SCHEMA_VERSION,
  }
  const compactionFact: RunCompactionFact = {
    type: 'compaction',
    at: startedAt + 90,
    trigger: 'auto',
    beforeTokens: 100_000,
    afterTokens: 8_100,
    messages: 42,
    durationMs: 4_300,
    status: 'success',
    schemaVersion: RUN_FACT_SCHEMA_VERSION,
  }
  await repository.appendFact('RUN_FACT_A', userFact, signal)
  await repository.appendFact('RUN_FACT_A', assistantFact, signal)
  await repository.appendFact('RUN_FACT_A', compactionFact, signal)

  await repository.finalize(
    'RUN_FACT_A',
    {
      status: SESSION_RUN_STATUSES.CANCELLED,
      endedAt: startedAt + 1_000,
      cancelledAt: startedAt + 1_000,
      cancelledBy: SESSION_RUN_CANCELLED_BY.USER,
    },
    signal
  )
  // 已终态 run 的追加与重复终态化都被拒绝，保证 append-only 语义。
  await assert.rejects(repository.appendFact('RUN_FACT_A', userFact, signal), /已终态/u)
  await assert.rejects(
    repository.finalize(
      'RUN_FACT_A',
      { status: SESSION_RUN_STATUSES.FAILED, endedAt: startedAt + 2_000 },
      signal
    ),
    /已终态/u
  )

  const runs = await repository.listBySession('SESS_FACT', signal)
  assert.equal(runs.length, 2)
  const cancelled = runs[0]
  assert.ok(cancelled !== undefined)
  assert.equal(cancelled.runId, 'RUN_FACT_A')
  assert.equal(cancelled.status, SESSION_RUN_STATUSES.CANCELLED)
  assert.equal(cancelled.cancelledBy, SESSION_RUN_CANCELLED_BY.USER)
  assert.equal(cancelled.cancelledAt, startedAt + 1_000)
  assert.equal(cancelled.endedAt, startedAt + 1_000)
  assert.deepEqual(cancelled.facts, [userFact, assistantFact, compactionFact])
  const running = runs[1]
  assert.ok(running !== undefined)
  assert.equal(running.status, SESSION_RUN_STATUSES.RUNNING)
  assert.equal(running.endedAt, null)
}

export async function publicTables(
  database: PostgresDatabase,
  signal: AbortSignal
): Promise<readonly string[]> {
  const result = await database.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    [],
    signal
  )
  return result.rows.map((row: unknown): string => stringField(row, 'tablename'))
}

export async function sessionFencingColumns(
  database: PostgresDatabase,
  signal: AbortSignal
): Promise<readonly string[]> {
  const result = await database.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'sessions'
       AND column_name IN ('revision', 'fencing_token')
     ORDER BY column_name`,
    [],
    signal
  )
  return result.rows.map((row: unknown): string => stringField(row, 'column_name'))
}

export async function subExecutionRevisionColumns(
  database: PostgresDatabase,
  signal: AbortSignal
): Promise<readonly string[]> {
  const result = await database.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'sub_agent_executions'
       AND column_name IN ('recovery_messages', 'revision')
     ORDER BY column_name`,
    [],
    signal
  )
  return result.rows.map((row: unknown): string => stringField(row, 'column_name'))
}

export async function subExecutionConcurrencyColumns(
  database: PostgresDatabase,
  signal: AbortSignal
): Promise<readonly string[]> {
  const result = await database.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'sub_agent_executions'
       AND column_name IN ('pending_interrupt_id', 'recovery_messages', 'revision')
     ORDER BY column_name`,
    [],
    signal
  )
  return result.rows.map((row: unknown): string => stringField(row, 'column_name'))
}

export function integrationSubExecution(): SubExecutionRecord {
  const now = new Date()
  return {
    executionId: 'SAEX_NEW',
    sessionId: 'SESSION_NEW',
    requestId: 'REQUEST_NEW',
    agentId: 'AGENT_NEW',
    agentName: '升级测试',
    userId: 'USER_NEW',
    userMessage: '测试 CAS',
    display: [],
    recoveryMessages: [],
    tokensUsed: 0,
    elapsedMilliseconds: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    revision: 0n,
  }
}
