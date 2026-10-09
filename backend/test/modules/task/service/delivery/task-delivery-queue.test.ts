import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runtimeMessages } from './../../../../helpers/runtime-state.js'
import { FailingSessionStore, createHarness, signal } from './task-delivery-test-support.js'

void describe('DeliveryQueue', () => {
  void it('enqueues the stable taskId:executionId entry format', async () => {
    const harness = createHarness()

    await harness.queue.enqueue('session-1', 'task-1', 'execution-1', signal())

    assert.deepEqual(await harness.store.list('delivery_queue:session-1', signal()), [
      'task-1:execution-1',
    ])
  })

  void it('enqueues, delivers, marks, and writes the scheduled task turn', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')

    await harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())

    const session = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.deepEqual(
      runtimeMessages(session.runtimeState).map(
        (message): string => `${message.role}:${message.content ?? ''}`
      ),
      ['user:（定时任务执行）提醒喝水', 'assistant:结果-execution-1']
    )
    assert.equal(session.displayMessages[0]?.source, 'scheduled_task')
    assert.equal(session.displayMessages[0]?.meta?.scheduledTask?.executionId, 'execution-1')
    assert.equal(harness.tasks.executions.get('execution-1')?.delivered, true)
    assert.deepEqual(await harness.store.list('delivery_queue:session-1', signal()), [])
  })

  void it('skips an already delivered entry and clears it from the queue', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    const current = harness.tasks.executions.get('execution-1')
    if (current === undefined) throw new Error('test execution missing')
    harness.tasks.executions.set('execution-1', { ...current, delivered: true })

    await harness.queue.enqueue('session-1', 'task-1', 'execution-1', signal())
    await harness.queue.drain('session-1', signal())

    assert.deepEqual(await harness.store.list('delivery_queue:session-1', signal()), [])
    const session = await harness.sessions.getOrCreate('session-1', 'user-1', signal())
    assert.equal(runtimeMessages(session.runtimeState).length, 0)
  })

  void it('requeues a failed delivery at the head without marking it delivered', async () => {
    const store = new FailingSessionStore()
    const harness = createHarness(store)
    harness.tasks.add('task-1', 'execution-1')

    await assert.rejects(
      harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())
    )

    assert.deepEqual(await harness.store.list('delivery_queue:session-1', signal()), [
      'task-1:execution-1',
    ])
    assert.equal(harness.tasks.executions.get('execution-1')?.delivered, false)
  })

  void it('defers when a session lock is owned by an active round', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    const held = await harness.locks.tryAcquire('session-1', 'active-round')

    await harness.queue.queueDeliverExecution('session-1', 'task-1', 'execution-1', signal())
    await held.release()

    assert.deepEqual(await harness.store.list('delivery_queue:session-1', signal()), [
      'task-1:execution-1',
    ])
    assert.equal(harness.tasks.executions.get('execution-1')?.delivered, false)
  })

  void it('reconciles missing undelivered executions and recovers claimed entries', async () => {
    const harness = createHarness()
    harness.tasks.add('task-1', 'execution-1')
    harness.tasks.add('task-1', 'execution-2')
    await harness.queue.enqueue('session-1', 'task-1', 'execution-1', signal())
    await harness.queue.reconcile('session-1', signal())
    assert.deepEqual(await harness.store.list('delivery_queue:session-1', signal()), [
      'task-1:execution-1',
      'task-1:execution-2',
    ])

    const recovered = createHarness()
    recovered.tasks.add('task-1', 'execution-1')
    recovered.store.seed('delivery_processing:session-1', 'task-1:execution-1')
    await recovered.queue.reconcile('session-1', signal())
    assert.deepEqual(await recovered.store.list('delivery_queue:session-1', signal()), [])
    await recovered.queue.drain('session-1', signal())
    assert.equal(recovered.tasks.executions.get('execution-1')?.delivered, true)
    assert.deepEqual(await recovered.store.list('delivery_processing:session-1', signal()), [])
  })
})
