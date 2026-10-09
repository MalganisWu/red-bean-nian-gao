import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerHealthRoutes } from '../../../../src/modules/system/http-api.js'
import type {
  HealthServicePort,
  ReadinessResult,
} from '../../../../src/modules/system/service/health/port/health-service.port.js'
import { createHttpServer } from '../../../../src/shared/http/fastify-http-boundary.js'
import type { IdGenerator } from '../../../../src/shared/id/id-generator.js'

const IDS: IdGenerator = { generate: (prefix): string => `${prefix}_test` }

class StubHealthService implements HealthServicePort {
  public readySignal: AbortSignal | undefined
  readonly #readiness: ReadinessResult

  public constructor(
    readiness: ReadinessResult = {
      status: 200,
      body: { status: 'ready', checks: { database: 'ok', redis: 'ok', storage: 'ok' } },
    }
  ) {
    this.#readiness = readiness
  }

  public health(): { readonly status: 'healthy' } {
    return { status: 'healthy' }
  }

  public version(): {
    readonly version: string
    readonly commit: string
    readonly built_at: string
  } {
    return { version: 'test', commit: 'abc', built_at: 'now' }
  }

  public setDraining(): void {}

  public ready(signal: AbortSignal): Promise<ReadinessResult> {
    this.readySignal = signal
    return Promise.resolve(this.#readiness)
  }
}

void describe('System health routes', () => {
  void it('delegates all probe response mapping to HealthController', async () => {
    const service = new StubHealthService()
    const server = createHttpServer({ idGenerator: IDS })
    registerHealthRoutes(server, service)
    await server.ready()

    const health = await server.inject({ method: 'GET', url: '/health' })
    const ready = await server.inject({ method: 'GET', url: '/readyz' })
    const version = await server.inject({ method: 'GET', url: '/version' })

    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { status: 'healthy' })
    assert.equal(ready.statusCode, 200)
    assert.deepEqual(ready.json(), {
      status: 'ready',
      checks: { database: 'ok', redis: 'ok', storage: 'ok' },
    })
    assert.ok(service.readySignal instanceof AbortSignal)
    assert.equal(version.statusCode, 200)
    assert.deepEqual(version.json(), { version: 'test', commit: 'abc', built_at: 'now' })

    await server.close()
  })

  void it('passes through a not-ready status from the service', async () => {
    const service = new StubHealthService({
      status: 503,
      body: { status: 'not_ready', checks: { server: 'draining' } },
    })
    const server = createHttpServer({ idGenerator: IDS })
    registerHealthRoutes(server, service)
    await server.ready()

    const response = await server.inject({ method: 'GET', url: '/readyz' })

    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), {
      status: 'not_ready',
      checks: { server: 'draining' },
    })
    assert.ok(service.readySignal instanceof AbortSignal)

    await server.close()
  })
})
