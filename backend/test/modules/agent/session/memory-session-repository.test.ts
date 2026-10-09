import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { RawMessage } from 'red-bean-qing-tuan/pipeline'

import {
  MemoryMessageBuffer,
  MemorySessionStore,
} from '../../../../src/modules/agent/session/repository/adapter/memory-session-repository.js'
import {
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
  type Session,
} from '../../../../src/modules/agent/session/model/session.js'
import { runtimeMessages, runtimeState } from '../../../helpers/runtime-state.js'

const SIGNAL = new AbortController().signal

void describe('memory session store', () => {
  void it('enforces ownership and returns deep copies', async () => {
    const store = new MemorySessionStore()
    const session: Session = {
      id: 'thread-1',
      userId: 'user-1',
      runtimeState: runtimeState([{ role: 'user', content: 'hello' }]),
      displayMessages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      revision: 0n,
      fencingToken: 0n,
    }
    await store.save(session, SIGNAL)

    const loaded = await store.getById('thread-1', 'user-1', SIGNAL)
    loaded.runtimeState = runtimeState([])
    loaded.displayMessages[0] = {
      role: 'user',
      content: 'changed',
      timestamp: 2,
    }
    const loadedAgain = await store.getById('thread-1', 'user-1', SIGNAL)
    assert.equal(runtimeMessages(loadedAgain.runtimeState)[0]?.content, 'hello')
    assert.equal(loadedAgain.displayMessages[0]?.content, 'hello')

    await assert.rejects(
      store.getById('thread-1', 'user-2', SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.NOT_FOUND)
    )
  })

  void it('rejects stale revisions and fencing tokens', async () => {
    const store = new MemorySessionStore()
    const session = await store.getOrCreate('thread-cas', 'user-1', SIGNAL)
    await store.advanceFence(session.id, session.userId, 10n, SIGNAL)
    session.fencingToken = 10n
    const staleRevision = structuredClone(session)
    await store.save(session, SIGNAL)
    assert.equal(session.revision, 1n)
    await assert.rejects(
      store.save(staleRevision, SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.REVISION_CONFLICT)
    )

    const current = await store.getById(session.id, session.userId, SIGNAL)
    await store.advanceFence(session.id, session.userId, 11n, SIGNAL)
    await assert.rejects(
      store.save(current, SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.STALE_FENCE)
    )
    await assert.rejects(
      store.advanceFence(session.id, session.userId, 9n, SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.STALE_FENCE)
    )
  })
})

void describe('memory message buffer', () => {
  void it('flush consumes a cloned message snapshot', async () => {
    const buffer = new MemoryMessageBuffer()
    const message: RawMessage = { role: 'assistant', content: 'partial' }
    await buffer.append('thread-1', message, SIGNAL)
    const messages = await buffer.flush('thread-1', SIGNAL)
    assert.deepEqual(messages, [message])
    assert.notEqual(messages[0], message)
    assert.deepEqual(await buffer.flush('thread-1', SIGNAL), [])
  })

  void it('peek retains messages and clear removes them', async () => {
    const buffer = new MemoryMessageBuffer()
    const message: RawMessage = { role: 'assistant', content: 'recoverable' }
    await buffer.append('thread-1', message, SIGNAL)
    assert.deepEqual(await buffer.peek('thread-1', SIGNAL), [message])
    assert.deepEqual(await buffer.peek('thread-1', SIGNAL), [message])
    await buffer.clear('thread-1', SIGNAL)
    assert.deepEqual(await buffer.peek('thread-1', SIGNAL), [])
  })
})

function isSessionError(
  code: (typeof SESSION_STORE_ERROR_CODES)[keyof typeof SESSION_STORE_ERROR_CODES]
): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof SessionStoreError && error.code === code
}
