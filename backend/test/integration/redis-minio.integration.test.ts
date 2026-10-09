import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { it } from 'node:test'
import { RedisCancelRegistry } from '../../src/modules/agent/cancellation/adapter/redis-cancellation-registry.js'
import { RedisSessionLockRegistry } from '../../src/modules/agent/session/lock/adapter/redis-session-lock.js'
import { MinioObjectStorage } from '../../src/modules/storage/service/object-storage/minio-object-storage.js'
import { connectRedis } from '../../src/infra/redis/redis.js'
import {
  REQUIRED_ENVIRONMENT,
  REDIS_URL_ENVIRONMENT,
  MINIO_ENDPOINT_ENVIRONMENT,
  COMPOSE_ENV_FILE_ENVIRONMENT,
  loadIntegrationRedisUrl,
  loadIntegrationMinioConfig,
  waitForAbort,
  readStream,
} from './integration-environment-test-support.js'

void it('runs cancellation and fenced session locks against real Redis', async (test) => {
  const redisUrl = await loadIntegrationRedisUrl()
  if (redisUrl === undefined) {
    const message = `${REDIS_URL_ENVIRONMENT} 或 ${COMPOSE_ENV_FILE_ENVIRONMENT} 未设置`
    if (process.env[REQUIRED_ENVIRONMENT] === '1') throw new Error(message)
    test.skip(`${message}，跳过集成测试`)
    return
  }

  const signal = AbortSignal.timeout(30_000)
  const redis = await connectRedis(redisUrl, signal)
  const suffix = `${String(process.pid)}-${String(Date.now())}`
  const requestId = `integration-request-${suffix}`
  const sessionId = `integration-session-${suffix}`
  try {
    const firstCancelRegistry = new RedisCancelRegistry(redis, { pollIntervalMilliseconds: 10 })
    const secondCancelRegistry = new RedisCancelRegistry(redis, { pollIntervalMilliseconds: 10 })
    const requestSignal = await firstCancelRegistry.wrap(undefined, requestId)
    assert.equal(await secondCancelRegistry.cancel(requestId), true)
    await waitForAbort(requestSignal, 2_000)
    await firstCancelRegistry.deregister(requestId)

    const lockRegistry = new RedisSessionLockRegistry(redis, {
      nextFencingToken: (): Promise<bigint> => Promise.resolve(991n),
      nonce: (): string => 'integration',
    })
    const lock = await lockRegistry.tryAcquire(sessionId, requestId)
    assert.equal(lock.fencingToken, 991n)
    assert.ok((await redis.ttlMilliseconds(`session_lock:${sessionId}`, signal)) > 0)
    await assert.rejects(lockRegistry.tryAcquire(sessionId, `${requestId}-conflict`))
    await lock.release()
    assert.equal(await redis.get(`session_lock:${sessionId}`, signal), undefined)
  } finally {
    await redis.delete(`agent:cancel:${requestId}`, signal)
    await redis.delete(`session_lock:${sessionId}`, signal)
    await redis.close()
  }
})

void it('uploads, reads, presigns and deletes an object against real MinIO', async (test) => {
  const config = await loadIntegrationMinioConfig()
  if (config === undefined) {
    const message = `${MINIO_ENDPOINT_ENVIRONMENT} 或 ${COMPOSE_ENV_FILE_ENVIRONMENT} 未设置`
    if (process.env[REQUIRED_ENVIRONMENT] === '1') throw new Error(message)
    test.skip(`${message}，跳过集成测试`)
    return
  }

  const signal = AbortSignal.timeout(30_000)
  const storage = new MinioObjectStorage(config)
  const key = `uploads/integration/${String(process.pid)}-${String(Date.now())}.txt`
  await storage.ensureBucket(signal)
  try {
    const uploaded = await storage.upload(
      {
        key,
        body: Readable.from([Buffer.from('hello MinIO')]),
        size: 11,
        contentType: 'text/plain',
      },
      signal
    )
    assert.equal(uploaded.key, key)
    assert.equal(uploaded.size, 11)
    assert.equal(uploaded.contentType, 'text/plain')

    const stat = await storage.stat(key, signal)
    assert.equal(stat?.etag, uploaded.etag)
    const download = await storage.download(key, signal)
    assert.equal(await readStream(download.body), 'hello MinIO')
    assert.match(await storage.presignGet({ key, expiresSeconds: 900 }, signal), /^https?:\/\//u)
    assert.match(await storage.presignPut({ key, expiresSeconds: 900 }, signal), /^https?:\/\//u)
  } finally {
    await storage.delete(key, signal)
  }
  assert.equal(await storage.stat(key, signal), undefined)
})
