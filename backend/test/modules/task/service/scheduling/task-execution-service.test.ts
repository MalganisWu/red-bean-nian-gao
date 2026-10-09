import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SCHEDULED_TASK_SYSTEM_PROMPT } from './../../../../../src/modules/task/service/scheduling/task-execution-service.js'
import {
  SIGNAL,
  RecordingBackgroundAgent,
  TestTaskRepository,
  RecordingQueue,
  task,
  createExecutionService,
} from './task-execution-test-support.js'

void describe('TaskExecutionService', () => {
  void it('claims the fencing token before invoking the background Agent', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task())
    repository.claimError = new Error('stale execution')
    const background = new RecordingBackgroundAgent()
    const execution = createExecutionService(repository, background)

    await assert.rejects(
      execution.run('task-1', { fencingToken: 9n, release: (): void => undefined }, SIGNAL),
      /stale execution/u
    )

    assert.deepEqual(repository.claims, [{ taskId: 'task-1', fencingToken: 9n }])
    assert.equal(background.commands.length, 0)
  })

  void it('只通过 Agent 公开 Port 执行并传入任务策略', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task({ taskInput: '每天九点查天气' }))
    const background = new RecordingBackgroundAgent()
    const execution = createExecutionService(repository, background)

    await execution.run('task-1', { fencingToken: 1n, release: (): void => undefined }, SIGNAL)

    assert.equal(background.commands[0]?.input, '每天九点查天气')
    assert.equal(background.commands[0]?.runId, 'TAEX_1')
    assert.equal(background.commands[0]?.sessionId, 'session-1')
    assert.equal(background.commands[0]?.userId, 'user-1')
    assert.equal(background.commands[0]?.traceId, 'trace-test')
    assert.equal(background.commands[0]?.attempt, 1)
    assert.equal(background.commands[0]?.systemPromptAppendix, SCHEDULED_TASK_SYSTEM_PROMPT)
    assert.deepEqual(background.commands[0]?.excludedToolNames, [
      'sys_ask_user',
      'sys_scheduled_task_manage',
      'sys_shell',
    ])
  })

  void it('截断超长输入并为空输入保留空字符串', async () => {
    const repository = new TestTaskRepository()
    const background = new RecordingBackgroundAgent()
    const execution = createExecutionService(repository, background)
    repository.tasks.set('task-1', task({ taskInput: '水'.repeat(4_001) }))
    await execution.run('task-1', { fencingToken: 1n, release: (): void => undefined }, SIGNAL)
    assert.equal(Array.from(background.commands[0]?.input ?? '').length, 4_000)

    repository.tasks.set('task-2', task({ taskId: 'task-2', taskInput: '' }))
    await execution.run('task-2', { fencingToken: 2n, release: (): void => undefined }, SIGNAL)
    assert.equal(background.commands[1]?.input, '')
  })

  void it('成功时保存展示结果、关闭一次性任务并投递', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task())
    const background = new RecordingBackgroundAgent()
    const queue = new RecordingQueue()
    const execution = createExecutionService(repository, background, queue)

    await execution.run('task-1', { fencingToken: 1n, release: (): void => undefined }, SIGNAL)

    const executionRecord = repository.executions.get('TAEX_1')
    assert.equal(executionRecord?.status, 'completed')
    assert.equal(executionRecord?.resultMessage, '完成')
    assert.equal(repository.tasks.get('task-1')?.isActive, false)
    assert.deepEqual(background.cleared, ['task-1'])
    assert.deepEqual(queue.entries, [
      { sessionId: 'session-1', taskId: 'task-1', executionId: 'TAEX_1' },
    ])
  })

  void it('中间失败只安排重试，不提前写执行记录或投递', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task({ retryCount: 0 }))
    const background = new RecordingBackgroundAgent()
    background.failure = new Error('temporary')
    const queue = new RecordingQueue()
    const execution = createExecutionService(repository, background, queue)

    await assert.rejects(
      execution.run('task-1', { fencingToken: 1n, release: (): void => undefined }, SIGNAL),
      /temporary/u
    )

    assert.equal(repository.tasks.get('task-1')?.retryCount, 1)
    assert.equal(repository.executions.size, 0)
    assert.equal(queue.entries.length, 0)
  })
})
