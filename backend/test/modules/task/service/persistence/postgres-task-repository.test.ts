import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeTaskListCursor } from './../../../../../src/modules/task/service/persistence/task-row-mapper.js'
import { TestPostgresTaskRepositories as PostgresTaskRepository } from './../../../../helpers/postgres-task-repositories.js'
import {
  TASK_REPOSITORY_ERROR_CODES,
  TaskRepositoryError,
} from './../../../../../src/modules/task/model/task.js'
import {
  RecordingDatabase,
  runAt,
  scheduledTaskRow,
  task,
  execution,
} from './postgres-task-repository-test-support.js'

void describe('PostgreSQL task repository behavior', () => {
  void it('uses a monotonic fencing token when claiming execution ownership', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [], rowCount: 1 })
    const now = new Date('2026-09-08T00:00:00.000Z')
    const repository = new PostgresTaskRepository(database, (): Date => now)

    await repository.claimExecution('STASK_1', 42n, AbortSignal.timeout(1_000))

    assert.match(database.queries[0]?.sql ?? '', /execution_fencing_token < \$1/u)
    assert.deepEqual(database.queries[0]?.parameters, ['42', now, 'STASK_1'])
  })

  void it('rejects a stale execution claim with a stable error code', async () => {
    const database = new RecordingDatabase()
    const repository = new PostgresTaskRepository(database)

    await assert.rejects(
      repository.claimExecution('STASK_1', 1n, AbortSignal.timeout(1_000)),
      (error: unknown): boolean => {
        assert.ok(error instanceof TaskRepositoryError)
        assert.equal(error.code, TASK_REPOSITORY_ERROR_CODES.STALE_EXECUTION)
        return true
      }
    )
  })

  void it('creates a task with derived persistence fields', async () => {
    const database = new RecordingDatabase()
    const repository = new PostgresTaskRepository(database)

    await repository.createTask(task, AbortSignal.timeout(1_000))

    assert.match(database.queries[0]?.sql ?? '', /INSERT INTO scheduled_tasks/u)
    assert.deepEqual(database.queries[0]?.parameters, [
      'STASK_1',
      'SESS_1',
      'USER_1',
      '整理项目进展',
      'once',
      runAt,
      null,
      runAt,
      false,
    ])
  })

  void it('returns a typed task and reports a stable not-found error', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [scheduledTaskRow], rowCount: 1 }, { rows: [], rowCount: 0 })
    const repository = new PostgresTaskRepository(database)
    const signal = AbortSignal.timeout(1_000)

    assert.deepEqual(await repository.getTask('STASK_1', signal), {
      ...task,
      taskInput: '每天早上9点查天气',
    })
    await assert.rejects(repository.getTask('missing', signal), (error: unknown): boolean => {
      assert.ok(error instanceof TaskRepositoryError)
      assert.equal(error.code, TASK_REPOSITORY_ERROR_CODES.NOT_FOUND)
      return true
    })
  })

  void it('scopes content changes and deletion by task ownership', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 })
    const repository = new PostgresTaskRepository(database)
    const signal = AbortSignal.timeout(1_000)

    await repository.updateTaskContent(task, signal)
    assert.match(database.queries[0]?.sql ?? '', /session_id = \$8 AND user_id = \$9/u)
    await assert.rejects(
      repository.softDeleteTask('USER_1', 'missing', signal),
      (error: unknown): boolean => {
        assert.ok(error instanceof TaskRepositoryError)
        assert.equal(error.code, TASK_REPOSITORY_ERROR_CODES.NOT_AUTHORIZED)
        return true
      }
    )
  })

  void it('atomically advances a task and inserts stable legacy-compatible JSON', async () => {
    const database = new RecordingDatabase()
    const repository = new PostgresTaskRepository(database)

    await repository.saveExecutionWithTaskUpdate(task, execution, AbortSignal.timeout(1_000))

    assert.equal(database.transactions, 1)
    assert.match(database.queries[0]?.sql ?? '', /UPDATE scheduled_tasks/u)
    assert.match(database.queries[1]?.sql ?? '', /INSERT INTO agent_task_executions/u)
    assert.deepEqual(JSON.parse(String(database.queries[1]?.parameters[7])), [
      { role: 'assistant', content: '完成', timestamp: 1 },
    ])
    assert.equal(database.queries[1]?.parameters[8], 'text')
  })

  void it('does not insert an execution after a fenced task update is rejected', async () => {
    const database = new RecordingDatabase()
    const repository = new PostgresTaskRepository(database)

    await assert.rejects(
      repository.saveExecutionWithTaskUpdate(task, execution, AbortSignal.timeout(1_000), 7n),
      (error: unknown): boolean => {
        assert.ok(error instanceof TaskRepositoryError)
        assert.equal(error.code, TASK_REPOSITORY_ERROR_CODES.STALE_EXECUTION)
        return true
      }
    )

    assert.equal(database.queries.length, 1)
    assert.match(database.queries[0]?.sql ?? '', /execution_fencing_token = \$5/u)
    assert.deepEqual(database.queries[0]?.parameters.slice(-1), ['7'])
  })

  void it('bounds pending scans', async () => {
    const database = new RecordingDatabase()
    database.results.push({ rows: [scheduledTaskRow], rowCount: 1 })
    const repository = new PostgresTaskRepository(database)
    const signal = AbortSignal.timeout(1_000)

    assert.equal((await repository.getPendingTasks(runAt, 5, signal)).length, 1)
    await assert.rejects(repository.getPendingTasks(runAt, 0, signal), /limit 必须大于 0/u)
  })

  void it('uses a stable task-list cursor and keeps the latest execution projection', async () => {
    const database = new RecordingDatabase()
    const row = {
      ...scheduledTaskRow,
      session_title: '会话',
      latest_execution_id: 'TAEX_1',
      latest_status: 'completed',
      latest_scheduled_at: runAt,
      latest_started_at: runAt,
      latest_completed_at: runAt,
      latest_result_message: '完成',
      latest_error_message: null,
    }
    database.results.push({ rows: [row, { ...row, scheduled_task_id: 'STASK_0' }], rowCount: 2 })
    const repository = new PostgresTaskRepository(database)

    const page = await repository.listItemsByUser('USER_1', '', 1, AbortSignal.timeout(1_000))

    assert.equal(page.items[0]?.latestExecution?.executionId, 'TAEX_1')
    assert.notEqual(page.nextCursor, '')
    assert.deepEqual(decodeTaskListCursor(page.nextCursor), {
      createdAt: scheduledTaskRow.created_at,
      taskId: 'STASK_1',
    })
  })

  void it('implements delivery CAS and ownership-safe view-state updates', async () => {
    const now = new Date('2026-09-04T12:00:00.000Z')
    const database = new RecordingDatabase()
    database.results.push(
      { rows: [], rowCount: 1 },
      {
        rows: [
          {
            execution_id: 'TAEX_1',
            seen_at: now,
            collapsed_override: false,
            updated_at: now,
          },
        ],
        rowCount: 1,
      }
    )
    const repository = new PostgresTaskRepository(database, (): Date => now)
    const signal = AbortSignal.timeout(1_000)

    assert.equal(await repository.markExecutionDelivered('TAEX_1', signal), true)
    const state = await repository.upsertExecutionViewState('USER_1', 'TAEX_1', true, false, signal)
    assert.equal(state.collapsedOverride, false)
    assert.deepEqual(database.queries[1]?.parameters, ['USER_1', now, false, now, 'TAEX_1', true])
  })

  void it('deduplicates execution IDs before querying user view states', async () => {
    const database = new RecordingDatabase()
    const repository = new PostgresTaskRepository(database)

    assert.deepEqual(
      await repository.listExecutionViewStates('USER_1', [], AbortSignal.timeout(1_000)),
      []
    )
    assert.equal(database.queries.length, 0)

    database.results.push({ rows: [], rowCount: 0 })
    await repository.listExecutionViewStates(
      'USER_1',
      ['TAEX_1', 'TAEX_1'],
      AbortSignal.timeout(1_000)
    )
    assert.deepEqual(database.queries[0]?.parameters, ['USER_1', ['TAEX_1']])
  })
})
