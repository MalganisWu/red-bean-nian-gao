import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REGISTRY_ERROR_CODES,
  RegistryError,
} from '../../../../src/modules/agent/session/lock/port/session-lock.js'

import { RedisCancelRegistry } from '../../../../src/modules/agent/cancellation/adapter/redis-cancellation-registry.js'
import { RedisSessionLockRegistry } from '../../../../src/modules/agent/session/lock/adapter/redis-session-lock.js'
import type { RedisStore } from '../../../../src/infra/redis/redis.js'

interface StoredValue {
  value: string
  ttlMilliseconds: number
}

class MemoryRedisStore implements RedisStore {
  public readonly values = new Map<string, StoredValue>()
  public renewCalls = 0

  public set(
    key: string,
    value: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    this.values.set(key, { value, ttlMilliseconds })
    return Promise.resolve()
  }

  public setIfAbsent(
    key: string,
    value: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    if (this.values.has(key)) return Promise.resolve(false)
    this.values.set(key, { value, ttlMilliseconds })
    return Promise.resolve(true)
  }

  public get(key: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted()
    return Promise.resolve(this.values.get(key)?.value)
  }

  public delete(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.values.delete(key)
    return Promise.resolve()
  }

  public compareAndExpire(
    key: string,
    expectedValue: string,
    ttlMilliseconds: number,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    this.renewCalls += 1
    const current = this.values.get(key)
    if (current?.value !== expectedValue) return Promise.resolve(false)
    this.values.set(key, { value: current.value, ttlMilliseconds })
    return Promise.resolve(true)
  }

  public compareAndDelete(
    key: string,
    expectedValue: string,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted()
    if (this.values.get(key)?.value !== expectedValue) return Promise.resolve(false)
    this.values.delete(key)
    return Promise.resolve(true)
  }

  public ttlMilliseconds(key: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    return Promise.resolve(this.values.get(key)?.ttlMilliseconds ?? -2)
  }
}

void describe('Redis cancel registry', () => {
  void it('cancels a request immediately in the same instance', async () => {
    const redis = new MemoryRedisStore()
    const registry = new RedisCancelRegistry(redis, { pollIntervalMilliseconds: 5 })
    const signal = await registry.wrap(undefined, 'req-1')

    assert.equal(await registry.cancel('req-1'), true)
    assert.equal(signal.aborted, true)
    await registry.deregister('req-1')
  })

  void it('returns false for an unknown request', async () => {
    const registry = new RedisCancelRegistry(new MemoryRedisStore())
    assert.equal(await registry.cancel('missing'), false)
  })

  void it('propagates cancellation across instances through Redis', async () => {
    const redis = new MemoryRedisStore()
    const first = new RedisCancelRegistry(redis, { pollIntervalMilliseconds: 5 })
    const second = new RedisCancelRegistry(redis, { pollIntervalMilliseconds: 5 })
    const signal = await first.wrap(undefined, 'req-cross')

    assert.equal(await second.cancel('req-cross'), true)
    await waitForAbort(signal)
    await first.deregister('req-cross')
  })

  void it('removes the Redis key when deregistered', async () => {
    const redis = new MemoryRedisStore()
    const registry = new RedisCancelRegistry(redis)
    await registry.wrap(undefined, 'req-deregister')

    await registry.deregister('req-deregister')

    assert.equal(redis.values.has('agent:cancel:req-deregister'), false)
    assert.equal(await registry.cancel('req-deregister'), false)
  })
})

void describe('Redis session lock registry', () => {
  void it('acquires a unique owner with a fencing token and TTL', async () => {
    const redis = new MemoryRedisStore()
    const registry = lockRegistry(redis, 42n)

    const lock = await registry.tryAcquire('session-1', 'request-1')

    assert.equal(lock.fencingToken, 42n)
    assert.match(redis.values.get('session_lock:session-1')?.value ?? '', /^request-1:42:/u)
    assert.equal(await redis.ttlMilliseconds('session_lock:session-1', liveSignal()), 300_000)
    await lock.release()
  })

  void it('rejects a second owner for the same session', async () => {
    const redis = new MemoryRedisStore()
    const registry = lockRegistry(redis, 1n)
    const first = await registry.tryAcquire('session-1', 'request-1')

    await assert.rejects(registry.tryAcquire('session-1', 'request-2'), (error: unknown) => {
      assert.ok(error instanceof RegistryError)
      assert.equal(error.code, REGISTRY_ERROR_CODES.LOCK_CONFLICT)
      return true
    })
    await first.release()
  })

  void it('only deletes a lock still owned by the releasing lease', async () => {
    const redis = new MemoryRedisStore()
    const registry = lockRegistry(redis, 2n)
    const lock = await registry.tryAcquire('session-1', 'request-1')
    await redis.set('session_lock:session-1', 'replacement', 60_000, liveSignal())

    await lock.release()

    assert.equal(redis.values.get('session_lock:session-1')?.value, 'replacement')
  })

  void it('makes release idempotent', async () => {
    const redis = new MemoryRedisStore()
    const lock = await lockRegistry(redis, 3n).tryAcquire('session-1', 'request-1')

    await lock.release()
    await lock.release()

    assert.equal(redis.values.has('session_lock:session-1'), false)
  })

  void it('renews the TTL while ownership is unchanged', async () => {
    const redis = new MemoryRedisStore()
    const lock = await lockRegistry(redis, 4n).tryAcquire('session-1', 'request-1')
    const key = 'session_lock:session-1'
    const owner = redis.values.get(key)?.value ?? ''
    await redis.set(key, owner, 2_000, liveSignal())

    await lock.renewNow()

    assert.equal(await redis.ttlMilliseconds(key, liveSignal()), 300_000)
    await lock.release()
  })

  void it('signals lease loss and cannot delete the replacement owner', async () => {
    const redis = new MemoryRedisStore()
    const lock = await lockRegistry(redis, 42n).tryAcquire('session-1', 'request-1')
    await redis.set('session_lock:session-1', 'replacement', 60_000, liveSignal())

    await lock.renewNow()
    const lost = await lock.lost

    assert.ok(lost instanceof RegistryError)
    assert.equal(lost.code, REGISTRY_ERROR_CODES.LEASE_LOST)
    await lock.release()
    assert.equal(redis.values.get('session_lock:session-1')?.value, 'replacement')
  })

  void it('stops background renewal after release', async () => {
    const redis = new MemoryRedisStore()
    const registry = new RedisSessionLockRegistry(redis, {
      ttlMilliseconds: 300_000,
      renewIntervalMilliseconds: 5,
      nextFencingToken: (): Promise<bigint> => Promise.resolve(8n),
      nonce: (): string => 'nonce',
    })
    const lock = await registry.tryAcquire('session-1', 'request-1')
    await delay(12)
    await lock.release()
    const renewCallsAfterRelease = redis.renewCalls

    await delay(15)

    assert.equal(redis.renewCalls, renewCallsAfterRelease)
  })
})

function lockRegistry(redis: RedisStore, token: bigint): RedisSessionLockRegistry {
  return new RedisSessionLockRegistry(redis, {
    nextFencingToken: (): Promise<bigint> => Promise.resolve(token),
    nonce: (): string => 'nonce',
  })
}

function liveSignal(): AbortSignal {
  return new AbortController().signal
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', (): void => resolve(), { once: true })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
