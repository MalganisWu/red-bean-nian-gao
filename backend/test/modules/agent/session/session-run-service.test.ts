import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RawMessage } from 'red-bean-qing-tuan/pipeline'
import { SessionLifecycle } from '../../../../src/modules/agent/session/run/service/default-session-run-service.js'
import {
  MemoryMessageBuffer,
  MemorySessionStore,
} from '../../../../src/modules/agent/session/repository/adapter/memory-session-repository.js'
import { SESSION_STORE_ERROR_CODES } from '../../../../src/modules/agent/session/model/session.js'
import { runtimeState } from '../../../helpers/runtime-state.js'
import {
  SIGNAL,
  TestLockRegistry,
  FailingGenerationClearBuffer,
  request,
  generation,
  sessionWithCard,
  isSessionError,
} from './session-run-service-test-support.js'

void describe('session lifecycle', () => {
  void it('recovers stale buffered messages before a new turn without duplicating committed data', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const existing = sessionWithCard('answered')
    const shared: RawMessage = { role: 'assistant', content: 'already saved' }
    existing.runtimeState = runtimeState([{ role: 'user', content: 'old' }, shared])
    await repository.save(existing, SIGNAL)
    await buffer.appendGeneration('session-1', generation(1n), shared, SIGNAL)
    await buffer.appendGeneration(
      'session-1',
      generation(1n),
      { role: 'user', content: 'recovered' },
      SIGNAL
    )

    const state = await new SessionLifecycle(repository, buffer).load(request([]), SIGNAL)

    assert.deepEqual(state.recoveryMessages, [shared, { role: 'user', content: 'recovered' }])
    assert.deepEqual(
      await buffer.peekGeneration('session-1', generation(1n), SIGNAL),
      state.recoveryMessages
    )
  })

  void it('makes an empty recovery a no-op and still releases the lock', async () => {
    const repository = new MemorySessionStore()
    const locks = new TestLockRegistry()
    const lifecycle = new SessionLifecycle(repository, new MemoryMessageBuffer(), locks)
    const state = await lifecycle.load(request([]), SIGNAL)

    await lifecycle.save(
      state,
      { displayMessages: [], executionError: new Error('before agent') },
      SIGNAL
    )

    assert.equal(locks.lock.releases, 1)
    assert.equal((await repository.getById('session-1', 'user-1', SIGNAL)).runtimeState, undefined)
  })

  void it('persists the submitted user message when the first run is cancelled early', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const lifecycle = new SessionLifecycle(repository, buffer)
    const state = await lifecycle.load(
      request([{ role: 'user', content: '请生成一篇长文' }]),
      SIGNAL
    )

    await lifecycle.save(
      state,
      { displayMessages: [], executionError: new Error('request cancelled') },
      SIGNAL
    )

    const saved = await repository.getById('session-1', 'user-1', SIGNAL)
    assert.equal(saved.displayMessages.length, 1)
    assert.equal(saved.displayMessages[0]?.role, 'user')
    assert.equal(saved.displayMessages[0]?.content, '请生成一篇长文')
    assert.deepEqual(
      await buffer.peekGeneration(
        state.checkpointId,
        generation(state.checkpointRevision, state.bufferWriteProof),
        SIGNAL
      ),
      []
    )
  })

  void it('releases the lock when completed persistence fails', async () => {
    const repository = new MemorySessionStore()
    const locks = new TestLockRegistry()
    const lifecycle = new SessionLifecycle(repository, new MemoryMessageBuffer(), locks)
    const state = await lifecycle.load(request([]), SIGNAL)
    const aborted = new AbortController()
    aborted.abort(new Error('database unavailable'))

    await assert.rejects(
      lifecycle.save(state, { displayMessages: [] }, aborted.signal),
      /database unavailable/u
    )
    assert.equal(locks.lock.releases, 1)
  })

  void it('propagates a save revision conflict and releases the lease', async () => {
    const repository = new MemorySessionStore()
    const locks = new TestLockRegistry()
    const lifecycle = new SessionLifecycle(repository, new MemoryMessageBuffer(), locks)
    const state = await lifecycle.load(request([]), SIGNAL)
    const concurrent = await repository.getById('session-1', 'user-1', SIGNAL)
    await repository.save(concurrent, SIGNAL)

    await assert.rejects(
      lifecycle.save(state, { displayMessages: [] }, SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.REVISION_CONFLICT)
    )
    assert.equal(locks.lock.releases, 1)
  })

  void it('rejects a successful execution that loses its lease before commit', async () => {
    const locks = new TestLockRegistry()
    const lifecycle = new SessionLifecycle(
      new MemorySessionStore(),
      new MemoryMessageBuffer(),
      locks
    )
    const state = await lifecycle.load(request([]), SIGNAL)
    locks.lock.lose(new Error('lease lost'))

    await assert.rejects(lifecycle.save(state, { displayMessages: [] }, SIGNAL), /已丢失 lease/u)
    assert.equal(locks.lock.releases, 1)
  })

  void it('does not replay a committed generation when buffer cleanup fails', async () => {
    const repository = new MemorySessionStore()
    const buffer = new FailingGenerationClearBuffer()
    const lifecycle = new SessionLifecycle(repository, buffer)
    const state = await lifecycle.load(request([{ role: 'user', content: '只处理一次' }]), SIGNAL)

    await assert.rejects(
      lifecycle.save(
        state,
        {
          runtimeState: runtimeState([
            { role: 'user', content: '只处理一次' },
            { role: 'assistant', content: '已处理' },
          ]),
          displayMessages: [{ role: 'assistant', content: '已处理', timestamp: 1 }],
        },
        SIGNAL
      ),
      /injected clear failure/u
    )
    assert.deepEqual(await buffer.peekGeneration('session-1', generation(0n), SIGNAL), [
      { role: 'user', content: '只处理一次' },
    ])

    const next = await lifecycle.load(request([]), SIGNAL)
    assert.equal(next.checkpointRevision, 1n)
    assert.deepEqual(next.recoveryMessages, [])
  })

  void it('isolates a replacement lease from an old owner at the same revision', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const first = new SessionLifecycle(repository, buffer, new TestLockRegistry(7n))
    const oldState = await first.load(request([{ role: 'user', content: '旧 owner 输入' }]), SIGNAL)
    const replacement = new SessionLifecycle(repository, buffer, new TestLockRegistry(8n))
    const newState = await replacement.load(request([]), SIGNAL)

    assert.equal(newState.checkpointRevision, oldState.checkpointRevision)
    assert.notEqual(newState.fencingToken, oldState.fencingToken)
    assert.deepEqual(newState.recoveryMessages, [{ role: 'user', content: '旧 owner 输入' }])
    assert.deepEqual(
      await buffer.peekGeneration(
        newState.checkpointId,
        generation(newState.checkpointRevision, newState.bufferWriteProof),
        SIGNAL
      ),
      [{ role: 'user', content: '旧 owner 输入' }]
    )
  })

  void it('translates lock conflicts into the stable session-facing error', async () => {
    const locks = new TestLockRegistry()
    locks.conflict = true
    const lifecycle = new SessionLifecycle(
      new MemorySessionStore(),
      new MemoryMessageBuffer(),
      locks
    )

    await assert.rejects(lifecycle.load(request([]), SIGNAL), /正在被其他请求处理/u)
  })
})
