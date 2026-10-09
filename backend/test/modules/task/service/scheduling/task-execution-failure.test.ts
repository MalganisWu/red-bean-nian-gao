import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BackgroundAgentExecutionResult } from './../../../../../src/modules/agent/public-api.js'
import {
  SIGNAL,
  RecordingBackgroundAgent,
  TestTaskRepository,
  RecordingQueue,
  task,
  createExecutionService,
  isRecord,
} from './task-execution-test-support.js'

void describe('TaskExecutionService', () => {
  void it('最终失败保留过程 section 并生成稳定中文结果', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task({ retryCount: 2 }))
    const background = new RecordingBackgroundAgent()
    const execution = createExecutionService(repository, background)
    const failed: BackgroundAgentExecutionResult = {
      status: 'exhausted',
      reason: '达到最大迭代次数',
      output: '',
      displayMessages: [
        {
          role: 'assistant',
          sections: [{ type: 'reason', items: [{ itemType: 'step', content: '检查数据' }] }],
          timestamp: 1,
        },
      ],
    }
    background.result = failed

    await execution.run('task-1', { fencingToken: 1n, release: (): void => undefined }, SIGNAL)

    const executionRecord = repository.executions.get('TAEX_1')
    assert.match(executionRecord?.resultMessage ?? '', /限定步骤/u)
    assert.deepEqual(
      Array.isArray(executionRecord?.displayMessages[0]?.sections)
        ? executionRecord.displayMessages[0].sections.map((section): unknown =>
            isRecord(section) ? section['type'] : undefined
          )
        : [],
      ['content', 'reason']
    )
  })

  void it('持久化失败时不投递结果', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task({ retryCount: 2 }))
    repository.saveError = new Error('database unavailable')
    const background = new RecordingBackgroundAgent()
    const queue = new RecordingQueue()
    const execution = createExecutionService(repository, background, queue)

    await assert.rejects(
      execution.run('task-1', { fencingToken: 1n, release: (): void => undefined }, SIGNAL),
      /database unavailable/u
    )
    assert.equal(queue.entries.length, 0)
    assert.deepEqual(background.cleared, [])
  })

  void it('lease 已丢失时拒绝持久化结果', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task())
    const background = new RecordingBackgroundAgent()
    const execution = createExecutionService(repository, background)

    await assert.rejects(
      execution.run(
        'task-1',
        {
          fencingToken: 1n,
          lost: Promise.resolve(new Error('lease lost')),
          release: (): void => undefined,
        },
        SIGNAL
      ),
      /已丢失 lease/u
    )
    assert.equal(repository.executions.size, 0)
  })

  void it('运行异常会记录失败并向调度器重新抛出', async () => {
    const repository = new TestTaskRepository()
    repository.tasks.set('task-1', task({ retryCount: 2 }))
    const background = new RecordingBackgroundAgent()
    background.failure = new Error('model unavailable')
    const execution = createExecutionService(repository, background)

    await assert.rejects(
      execution.run('task-1', { fencingToken: 1n, release: (): void => undefined }, SIGNAL),
      /model unavailable/u
    )
    assert.equal(repository.executions.get('TAEX_1')?.status, 'failed')
  })
})
