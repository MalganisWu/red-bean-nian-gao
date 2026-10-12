import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  RedisMessageBuffer,
  type RedisMessageBufferStore,
} from '../../../../src/modules/agent/session/message-buffer/adapter/redis-message-buffer.js'

class MemoryRedisMessages implements RedisMessageBufferStore {
  readonly #values = new Map<string, string[]>()
  readonly #guards = new Map<string, string>()
  public appendedTtlSeconds = 0
  public lastAppendedKey = ''

  public appendListWithExpiry(
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    this.#values.set(key, [...(this.#values.get(key) ?? []), value])
    this.lastAppendedKey = key
    this.appendedTtlSeconds = ttlSeconds
    return Promise.resolve()
  }

  public listRange(key: string, signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted()
    return Promise.resolve([...(this.#values.get(key) ?? [])])
  }

  public appendListWithExpiryIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    if (this.#guards.get(guardKey) !== expectedValue) return Promise.resolve(false)
    return this.appendListWithExpiry(key, value, ttlSeconds, signal).then((): boolean => true)
  }

  public consumeList(key: string, signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted()
    const values = [...(this.#values.get(key) ?? [])]
    this.#values.delete(key)
    return Promise.resolve(values)
  }

  public delete(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.#values.delete(key)
    return Promise.resolve()
  }

  public deleteIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    if (this.#guards.get(guardKey) !== expectedValue) return Promise.resolve(false)
    this.#values.delete(key)
    return Promise.resolve(true)
  }

  public setGuard(key: string, value: string): void {
    this.#guards.set(key, value)
  }
}

void describe('Redis message buffer', () => {
  void it('uses the session key and a 24-hour atomic append TTL', async () => {
    const store = new MemoryRedisMessages()
    const buffer = new RedisMessageBuffer(store)
    const signal = AbortSignal.timeout(1_000)

    await buffer.append('SESSION_1', { role: 'user', content: '你好' }, signal)

    assert.equal(store.appendedTtlSeconds, 86_400)
    assert.deepEqual(await buffer.peek('SESSION_1', signal), [{ role: 'user', content: '你好' }])
  })

  void it('atomically consumes messages and rejects malformed Redis JSON', async () => {
    const store = new MemoryRedisMessages()
    const buffer = new RedisMessageBuffer(store)
    const signal = AbortSignal.timeout(1_000)
    await buffer.append('SESSION_1', { role: 'assistant', content: '完成' }, signal)

    assert.deepEqual(await buffer.flush('SESSION_1', signal), [
      { role: 'assistant', content: '完成' },
    ])
    assert.deepEqual(await buffer.peek('SESSION_1', signal), [])

    await store.appendListWithExpiry('agent:cache:BROKEN:buffer', '{', 1, signal)
    await assert.rejects(buffer.peek('BROKEN', signal), /反序列化消息失败/u)
  })

  void it('preserves pre-takeover writes and atomically rejects the old owner after takeover', async () => {
    const store = new MemoryRedisMessages()
    const buffer = new RedisMessageBuffer(store)
    const signal = AbortSignal.timeout(1_000)

    store.setGuard('session_lock:SESSION_1', 'owner-11')
    await buffer.appendGeneration(
      'SESSION_1',
      { revision: 7n, writeProof: 'owner-11' },
      { role: 'user', content: '旧轮次' },
      signal
    )

    assert.equal(store.lastAppendedKey, 'agent:cache:SESSION_1:buffer:7')
    store.setGuard('session_lock:SESSION_1', 'owner-12')
    await assert.rejects(
      buffer.appendGeneration(
        'SESSION_1',
        { revision: 7n, writeProof: 'owner-11' },
        { role: 'assistant', content: '旧 owner 迟到写' },
        signal
      ),
      /owner 已失效/u
    )
    assert.deepEqual(
      await buffer.peekGeneration('SESSION_1', { revision: 7n, writeProof: 'owner-12' }, signal),
      [{ role: 'user', content: '旧轮次' }]
    )
  })
})
