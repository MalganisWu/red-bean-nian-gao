import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ManagedChatRunHandle } from '../../../../../src/modules/agent/chat/stream/chat-run-handle.js'

void describe('ManagedChatRunHandle', () => {
  void it('主动关闭时取消后台信号并给出明确 completion', async () => {
    const handle = new ManagedChatRunHandle('RUN_1', 'SESS_1', new AbortController().signal)

    const closing = handle.close('client_disconnected')

    assert.equal(handle.signal.aborted, true)
    let finalized = false
    void closing.then((): void => {
      finalized = true
    })
    await Promise.resolve()
    assert.equal(finalized, false)
    handle.complete()
    await closing
    assert.deepEqual(await handle.completion, {
      status: 'cancelled',
      reason: 'client_disconnected',
    })
  })

  void it('慢消费者超过有界队列容量时取消生产者', async () => {
    const handle = new ManagedChatRunHandle('RUN_1', 'SESS_1', new AbortController().signal, 1)

    handle.publish({ type: 'token', content: 'first' })
    handle.publish({ type: 'token', content: 'overflow' })

    assert.equal(handle.signal.aborted, true)
    const iterator = handle.events[Symbol.asyncIterator]()
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { type: 'token', content: 'first' },
    })
    await assert.rejects(iterator.next(), /事件队列超过容量/u)
  })
})
