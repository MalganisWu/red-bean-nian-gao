import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runtimeMessages, runtimeState } from './../../../../helpers/runtime-state.js'
import { createHarness, display, signal } from './task-delivery-test-support.js'

void describe('DeliveryQueue', () => {
  void it('reconciles all sessions and permits a drain called by an already locked round', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1', 'session-1')
    harness.tasks.add('task-2', 'execution-2', 'session-2')
    await harness.queue.reconcileAll(signal())
    assert.equal(harness.tasks.executions.get('execution-1')?.delivered, true)
    assert.equal(harness.tasks.executions.get('execution-2')?.delivered, true)

    const second = createHarness()
    second.tasks.add('task-1', 'execution-1')
    await second.queue.enqueue('session-1', 'task-1', 'execution-1', signal())
    await second.queue.drain('session-1', signal())
    assert.equal(second.tasks.executions.get('execution-1')?.delivered, true)
  })

  void it('appends a task turn after an already saved conversation turn', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    const savedConversation = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    savedConversation.runtimeState = runtimeState([{ role: 'assistant', content: '这是本轮对话' }])
    await harness.sessions.save(savedConversation, signal())
    await harness.queue.enqueue('session-1', 'task-1', 'execution-1', signal())

    await harness.queue.drain('session-1', signal())

    const session = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.deepEqual(
      runtimeMessages(session.runtimeState).map(
        (message): string => `${message.role}:${message.content ?? ''}`
      ),
      ['assistant:这是本轮对话', 'user:（定时任务执行）提醒喝水', 'assistant:结果-execution-1']
    )
  })

  void it('does not duplicate a session that was committed before delivery marking', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    const session = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    session.displayMessages.push(display('execution-1'))
    session.runtimeState = runtimeState([
      { role: 'user', content: '（定时任务执行）提醒喝水' },
      { role: 'assistant', content: '结果-execution-1' },
    ])
    await harness.sessions.save(session, signal())

    await harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())

    const saved = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.equal(saved.displayMessages.length, 1)
    assert.equal(runtimeMessages(saved.runtimeState).length, 2)
    assert.equal(harness.tasks.executions.get('execution-1')?.delivered, true)
  })

  void it('falls back to the persisted result message and carries scheduled task metadata', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    const current = harness.tasks.executions.get('execution-1')
    if (current === undefined) throw new Error('test execution missing')
    harness.tasks.executions.set('execution-1', {
      ...current,
      completedAt: new Date('2026-08-04T10:00:03.000Z'),
      displayMessages: [{ role: 'user', timestamp: 1 }],
      resultMessage: '你想确认哪种类型的提醒？',
    })

    await harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())

    const session = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.equal(session.displayMessages[0]?.content, '你想确认哪种类型的提醒？')
    assert.equal(session.displayMessages[0]?.meta?.scheduledTask?.scheduledAt, 1_785_837_600_000)
    assert.equal(session.displayMessages[0]?.meta?.scheduledTask?.completedAt, 1_785_837_603_000)
  })

  void it('uses zero completedAt for unfinished metadata and defers only pending cards', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    const pending = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    pending.displayMessages.push({
      role: 'assistant',
      sections: [{ type: 'card', card: { status: 'pending' } }],
      timestamp: 1,
    })
    await harness.sessions.save(pending, signal())

    await harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())
    assert.equal(harness.tasks.executions.get('execution-1')?.delivered, false)
    assert.deepEqual(await harness.store.list('delivery_queue:session-1', signal()), [
      'task-1:execution-1',
    ])

    const answered = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    answered.displayMessages = [
      {
        role: 'assistant',
        sections: [{ type: 'card', card: { status: 'answered' } }],
        timestamp: 1,
      },
    ]
    await harness.sessions.save(answered, signal())
    await harness.queue.drain('session-1', signal())
    const saved = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.equal(saved.displayMessages[1]?.meta?.scheduledTask?.completedAt, 0)
  })

  void it('uses a metadata-only display marker to deduplicate an empty result', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    const current = harness.tasks.executions.get('execution-1')
    if (current === undefined) throw new Error('test execution missing')
    harness.tasks.executions.set('execution-1', {
      ...current,
      displayMessages: [],
      resultMessage: '',
    })

    await harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())
    const saved = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.equal(saved.displayMessages[0]?.meta?.scheduledTask?.executionId, 'execution-1')

    const stale = harness.tasks.executions.get('execution-1')
    if (stale === undefined) throw new Error('test execution missing')
    harness.tasks.executions.set('execution-1', { ...stale, delivered: false })
    await harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())
    const retried = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.equal(retried.displayMessages.length, 1)
  })
})
