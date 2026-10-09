import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { HealthService } from '../../../../../src/modules/system/service/health/default-health-service.js'

void describe('TypeScript backend health service', () => {
  void it('keeps liveness independent from infrastructure', () => {
    const service = new HealthService({
      database: (): Promise<void> => Promise.reject(new Error('down')),
      redis: (): Promise<void> => Promise.reject(new Error('down')),
      storage: (): Promise<void> => Promise.reject(new Error('down')),
    })
    assert.deepEqual(service.health(), { status: 'healthy' })
  })

  void it('reports readiness and immutable version metadata', async () => {
    const service = new HealthService(
      {
        database: (): Promise<void> => Promise.resolve(),
        redis: (): Promise<void> => Promise.resolve(),
        storage: (): Promise<void> => Promise.resolve(),
      },
      { version: '1.2.3', commit: 'abc123', builtAt: 'now' }
    )
    assert.deepEqual(service.version(), {
      version: '1.2.3',
      commit: 'abc123',
      built_at: 'now',
    })
    assert.deepEqual(await service.ready(new AbortController().signal), {
      status: 200,
      body: {
        status: 'ready',
        checks: { database: 'ok', redis: 'ok', storage: 'ok' },
      },
    })
  })

  void it('fails readiness safely and becomes not-ready while draining', async () => {
    const service = new HealthService({
      database: (): Promise<void> => Promise.resolve(),
      redis: (): Promise<void> => Promise.reject(new Error('down')),
      storage: (): Promise<void> => Promise.resolve(),
    })
    assert.deepEqual(await service.ready(new AbortController().signal), {
      status: 503,
      body: {
        status: 'not_ready',
        checks: { database: 'ok', redis: 'error', storage: 'ok' },
      },
    })
    service.setDraining(true)
    assert.deepEqual(await service.ready(new AbortController().signal), {
      status: 503,
      body: { status: 'not_ready', checks: { server: 'draining' } },
    })
  })

  void it('bounds each readiness check with a timeout', async () => {
    const never = (): Promise<void> => new Promise((): void => {})
    const service = new HealthService(
      { database: never, redis: never, storage: never },
      undefined,
      5
    )
    const result = await service.ready(new AbortController().signal)
    assert.equal(result.status, 503)
    assert.deepEqual(result.body.checks, {
      database: 'error',
      redis: 'error',
      storage: 'error',
    })
  })
})
