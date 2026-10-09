import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decodeTaskListCursor,
  encodeTaskListCursor,
  mapExecutionRow,
  mapScheduledTaskRow,
  mapTaskListRow,
  mapViewStateRow,
} from './../../../../../src/modules/task/service/persistence/task-row-mapper.js'
import { runAt, scheduledTaskRow } from './postgres-task-repository-test-support.js'

void describe('PostgreSQL task repository row mapping', () => {
  void it('maps every scheduled task read field', () => {
    assert.deepEqual(mapScheduledTaskRow(scheduledTaskRow), {
      taskId: 'STASK_1',
      sessionId: 'SESS_1',
      userId: 'USER_1',
      taskInput: '每天早上9点查天气',
      scheduleType: 'once',
      runAt,
      cronExpr: '',
      nextRunAt: runAt,
      isActive: true,
      retryCount: 0,
    })
  })

  void it('maps nullable dates to undefined', () => {
    const task = mapScheduledTaskRow({
      ...scheduledTaskRow,
      run_at: null,
      next_run_at: null,
    })

    assert.equal(task.runAt, undefined)
    assert.equal(task.nextRunAt, undefined)
  })

  void it('derives a missing schedule type from is_recurring', () => {
    assert.equal(
      mapScheduledTaskRow({ ...scheduledTaskRow, schedule_type: '', is_recurring: true })
        .scheduleType,
      'recurring'
    )
    assert.equal(
      mapScheduledTaskRow({ ...scheduledTaskRow, schedule_type: '', is_recurring: false })
        .scheduleType,
      'once'
    )
  })

  void it('maps execution JSON and preserves delivered=true', () => {
    const execution = mapExecutionRow({
      execution_id: 'TAEX_1',
      task_id: 'STASK_1',
      session_id: 'SESS_1',
      status: 'completed',
      scheduled_at: runAt,
      started_at: null,
      completed_at: null,
      display_messages: [{ role: 'assistant', content: '完成', timestamp: 1 }],
      result_type: 'text',
      result_message: '完成',
      error_message: null,
      delivered: true,
      created_at: runAt,
    })

    assert.equal(execution.delivered, true)
    assert.equal(execution.displayMessages[0]?.content, '完成')
    assert.equal(execution.resultMessage, '完成')
  })

  // 存量行的 display_messages 仍带已删除的 `think` / `steps`。schema 非 strict，必须 strip 而非抛错，
  // 否则老库一读就报「执行记录行数据无效」。R25 要求的回归覆盖。
  void it('strips removed think and steps fields from a legacy execution row', () => {
    const execution = mapExecutionRow({
      execution_id: 'TAEX_LEGACY',
      task_id: 'STASK_1',
      session_id: 'SESS_1',
      status: 'completed',
      scheduled_at: runAt,
      started_at: null,
      completed_at: null,
      display_messages: [
        {
          role: 'assistant',
          content: '旧格式结果',
          timestamp: 1,
          think: [{ content: '旧推理', timestamp: 1 }],
          steps: [{ type: 'process', items: [] }],
        },
      ],
      result_type: 'text',
      result_message: '旧格式结果',
      error_message: null,
      delivered: true,
      created_at: runAt,
    })

    assert.deepEqual(execution.displayMessages, [
      { role: 'assistant', content: '旧格式结果', timestamp: 1 },
    ])
  })

  void it('preserves delivered=false', () => {
    const execution = mapExecutionRow({
      execution_id: 'TAEX_2',
      task_id: 'STASK_1',
      session_id: 'SESS_1',
      status: 'completed',
      scheduled_at: runAt,
      started_at: null,
      completed_at: null,
      display_messages: [],
      result_type: null,
      result_message: null,
      error_message: null,
      delivered: false,
      created_at: runAt,
    })

    assert.equal(execution.delivered, false)
  })

  void it('preserves nullable view-state fields including false', () => {
    const updatedAt = new Date('2026-08-28T09:01:00.000Z')
    const state = mapViewStateRow({
      execution_id: 'EXEC_1',
      seen_at: runAt,
      collapsed_override: false,
      updated_at: updatedAt,
    })

    assert.deepEqual(state, {
      executionId: 'EXEC_1',
      seenAt: runAt,
      collapsedOverride: false,
      updatedAt,
    })
  })

  void it('maps task-list projection and truncates a Unicode session title', () => {
    const result = mapTaskListRow({
      ...scheduledTaskRow,
      session_title: '豆'.repeat(31),
      latest_execution_id: 'EXEC_1',
      latest_status: 'completed',
      latest_scheduled_at: runAt,
      latest_started_at: runAt,
      latest_completed_at: runAt,
      latest_result_message: '任务已完成',
      latest_error_message: null,
    })

    assert.equal(result.sessionTitle, `${'豆'.repeat(30)}...`)
    assert.equal(result.latestExecution?.executionId, 'EXEC_1')
    assert.equal(result.latestExecution?.resultMessage, '任务已完成')
  })

  void it('leaves a missing latest execution undefined', () => {
    const result = mapTaskListRow({
      ...scheduledTaskRow,
      session_title: '普通会话',
      latest_execution_id: null,
      latest_status: null,
      latest_scheduled_at: null,
      latest_started_at: null,
      latest_completed_at: null,
      latest_result_message: null,
      latest_error_message: null,
    })

    assert.equal(result.latestExecution, undefined)
  })

  void it('bounds projected execution messages by Unicode code points', () => {
    const result = mapTaskListRow({
      ...scheduledTaskRow,
      session_title: '',
      latest_execution_id: 'EXEC_2',
      latest_status: 'failed',
      latest_scheduled_at: runAt,
      latest_started_at: null,
      latest_completed_at: null,
      latest_result_message: '豆'.repeat(300),
      latest_error_message: null,
    })

    assert.equal(Array.from(String(result.latestExecution?.resultMessage)).length, 256)
  })

  void it('round-trips a stable cursor with a tie-breaker', () => {
    const createdAt = new Date('2026-08-28T10:11:12.123Z')
    const encoded = encodeTaskListCursor(createdAt, 'TASK_9')

    assert.deepEqual(decodeTaskListCursor(encoded), { createdAt, taskId: 'TASK_9' })
  })

  void it('rejects legacy and malformed cursor values', () => {
    for (const value of ['', '2026-08-28T10:11:12Z', 'not-a-cursor']) {
      assert.equal(decodeTaskListCursor(value), undefined)
    }
  })

  void it('rejects malformed database JSON at the trust boundary', () => {
    assert.throws(
      () =>
        mapExecutionRow({
          execution_id: 'TAEX_BAD',
          task_id: 'STASK_1',
          session_id: 'SESS_1',
          status: 'completed',
          scheduled_at: runAt,
          started_at: null,
          completed_at: null,
          display_messages: [{ role: 42 }],
          result_type: null,
          result_message: null,
          error_message: null,
          delivered: false,
          created_at: runAt,
        }),
      /执行记录行数据无效/u
    )
  })
})
