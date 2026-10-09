import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RawMessage } from 'red-bean-qing-tuan/pipeline'
import { SessionLifecycle } from '../../../../src/modules/agent/session/run/service/default-session-run-service.js'
import {
  MemoryMessageBuffer,
  MemorySessionStore,
} from '../../../../src/modules/agent/session/repository/adapter/memory-session-repository.js'
import { SESSION_STORE_ERROR_CODES } from '../../../../src/modules/agent/session/model/session.js'
import { runtimeMessages, runtimeState } from '../../../helpers/runtime-state.js'
import {
  SIGNAL,
  TestLockRegistry,
  FailingAppendBuffer,
  request,
  generation,
  answerMarker,
  sessionWithCard,
  isSessionError,
} from './session-run-service-test-support.js'

void describe('session lifecycle', () => {
  void it('loads history, persists the completed turn and releases its lock', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const locks = new TestLockRegistry()
    const existing = sessionWithCard('answered')
    existing.runtimeState = runtimeState([{ role: 'assistant', content: 'history' }])
    await repository.save(existing, SIGNAL)
    const lifecycle = new SessionLifecycle(repository, buffer, locks)

    const state = await lifecycle.load(request([{ role: 'user', content: 'next' }]), SIGNAL)
    assert.deepEqual(state.runtimeState, existing.runtimeState)
    assert.equal(state.fencingToken, 7n)
    assert.equal(state.checkpointRevision, 1n)
    assert.deepEqual(
      await buffer.peekGeneration(state.checkpointId, generation(1n, 'owner-7'), SIGNAL),
      [{ role: 'user', content: 'next' }]
    )

    await lifecycle.save(
      state,
      {
        runtimeState: runtimeState([
          ...runtimeMessages(state.runtimeState),
          { role: 'user', content: 'next' },
          { role: 'assistant', content: 'done' },
        ]),
        displayMessages: [{ role: 'assistant', content: 'done', timestamp: 10 }],
      },
      SIGNAL
    )

    const saved = await repository.getById('session-1', 'user-1', SIGNAL)
    assert.equal(runtimeMessages(saved.runtimeState).at(-1)?.content, 'done')
    assert.equal(saved.displayMessages.at(-1)?.content, 'done')
    assert.equal(locks.lock.releases, 1)
    assert.deepEqual(
      await buffer.peekGeneration(state.checkpointId, generation(1n, 'owner-7'), SIGNAL),
      []
    )
  })

  void it('rejects ordinary chat during a pending card and releases the acquired lock', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const locks = new TestLockRegistry()
    await repository.save(sessionWithCard('pending'), SIGNAL)

    await assert.rejects(
      new SessionLifecycle(repository, buffer, locks).load(request([]), SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT)
    )
    assert.equal(locks.lock.releases, 1)
  })

  void it('releases the acquired lease when buffering the submitted message fails', async () => {
    const locks = new TestLockRegistry()
    const lifecycle = new SessionLifecycle(
      new MemorySessionStore(),
      new FailingAppendBuffer(),
      locks
    )

    await assert.rejects(lifecycle.load(request([{ role: 'user', content: '输入' }]), SIGNAL), {
      message: 'injected append failure',
    })
    assert.equal(locks.lock.releases, 1)
  })

  void it('converts an answer into an explicit Runtime resume request', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    await repository.save(sessionWithCard('pending'), SIGNAL)
    const lifecycle = new SessionLifecycle(repository, buffer)
    const answer = answerMarker()

    const state = await lifecycle.load({ ...request([]), answer }, SIGNAL)

    assert.equal(state.resume?.interruptId, answer.interactionId)
    assert.match(state.resume?.response ?? '', /"answered"/u)
    assert.deepEqual(await buffer.peekGeneration(state.checkpointId, generation(1n), SIGNAL), [])
  })

  void it('injects the stable refusal result', async () => {
    const repository = new MemorySessionStore()
    await repository.save(sessionWithCard('pending'), SIGNAL)
    const lifecycle = new SessionLifecycle(repository, new MemoryMessageBuffer())

    const state = await lifecycle.load(
      { ...request([]), answer: { ...answerMarker(), refused: true } },
      SIGNAL
    )

    assert.match(state.resume?.response ?? '', /"refused"/u)
  })

  void it('rejects a missing or already resolved answer interaction', async () => {
    const repository = new MemorySessionStore()
    await repository.save(sessionWithCard('answered'), SIGNAL)
    const lifecycle = new SessionLifecycle(repository, new MemoryMessageBuffer())

    await assert.rejects(
      lifecycle.load({ ...request([]), answer: answerMarker() }, SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT)
    )

    const pendingRepository = new MemorySessionStore()
    await pendingRepository.save(sessionWithCard('pending'), SIGNAL)
    await assert.rejects(
      new SessionLifecycle(pendingRepository, new MemoryMessageBuffer()).load(
        {
          ...request([]),
          answer: { ...answerMarker(), interactionId: 'call_missing' },
        },
        SIGNAL
      ),
      isSessionError(SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT)
    )
  })

  void it('resolves the card and merges answer continuation into the same display message', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    await repository.save(sessionWithCard('pending'), SIGNAL)
    const lifecycle = new SessionLifecycle(repository, buffer)
    const state = await lifecycle.load({ ...request([]), answer: answerMarker() }, SIGNAL)

    await lifecycle.save(
      state,
      {
        runtimeState: state.runtimeState,
        displayMessages: [
          {
            role: 'assistant',
            sections: [{ type: 'content', content: '继续完成', timestamp: 3 }],
            timestamp: 3,
          },
        ],
      },
      SIGNAL
    )

    const saved = await repository.getById('session-1', 'user-1', SIGNAL)
    assert.equal(saved.displayMessages.length, 1)
    const sections = saved.displayMessages[0]?.sections
    assert.ok(Array.isArray(sections))
    assert.deepEqual(
      sections.map((section): unknown =>
        typeof section === 'object' && section !== null && 'type' in section
          ? section['type']
          : undefined
      ),
      ['reason', 'card', 'content']
    )
  })

  void it('persists a refused card without answer data', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    await repository.save(sessionWithCard('pending'), SIGNAL)
    const lifecycle = new SessionLifecycle(repository, buffer)
    const state = await lifecycle.load(
      { ...request([]), answer: { ...answerMarker(), refused: true } },
      SIGNAL
    )

    await lifecycle.save(state, { runtimeState: state.runtimeState, displayMessages: [] }, SIGNAL)

    const saved = await repository.getById('session-1', 'user-1', SIGNAL)
    const serialized = JSON.stringify(saved.displayMessages)
    assert.match(serialized, /"status":"refused"/u)
    assert.doesNotMatch(serialized, /"answers"/u)
  })

  void it('persists a consumed answer when execution fails before buffering messages', async () => {
    const repository = new MemorySessionStore()
    await repository.save(sessionWithCard('pending'), SIGNAL)
    const lifecycle = new SessionLifecycle(repository, new MemoryMessageBuffer())
    const answer = answerMarker()
    const state = await lifecycle.load({ ...request([]), answer }, SIGNAL)

    await lifecycle.save(
      state,
      { displayMessages: [], executionError: new Error('resume failed before output') },
      SIGNAL
    )

    const saved = await repository.getById('session-1', 'user-1', SIGNAL)
    assert.match(JSON.stringify(saved.displayMessages), /"status":"answered"/u)
    await assert.rejects(
      lifecycle.load({ ...request([]), answer }, SIGNAL),
      isSessionError(SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT)
    )
  })

  void it('recovers partial tool batches, resolves consumed answers and clears the buffer', async () => {
    const repository = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    await repository.save(sessionWithCard('pending'), SIGNAL)
    const lifecycle = new SessionLifecycle(repository, buffer)
    const state = await lifecycle.load({ ...request([]), answer: answerMarker() }, SIGNAL)
    const dangling: RawMessage = {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: 'call_fetch',
          type: 'function',
          function: { name: 'sys_fetch_url', arguments: '{}' },
        },
      ],
    }
    await buffer.appendGeneration(
      state.checkpointId,
      generation(state.checkpointRevision, state.bufferWriteProof),
      dangling,
      SIGNAL
    )

    await lifecycle.save(
      state,
      {
        runtimeState: runtimeState([
          ...runtimeMessages(state.runtimeState),
          dangling,
          { role: 'tool', content: '工具执行被中断', toolCallId: 'call_fetch' },
        ]),
        displayMessages: [],
        executionError: new Error('stream interrupted'),
      },
      SIGNAL
    )

    const saved = await repository.getById('session-1', 'user-1', SIGNAL)
    assert.equal(
      runtimeMessages(saved.runtimeState).some(
        (message): boolean => message.toolCallId === 'call_fetch'
      ),
      true
    )
    assert.equal(saved.displayMessages[0]?.sections !== undefined, true)
    assert.deepEqual(
      await buffer.peekGeneration(
        state.checkpointId,
        generation(state.checkpointRevision, state.bufferWriteProof),
        SIGNAL
      ),
      []
    )
  })
})
