import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ApiRouteDefinition } from '@red-bean/api-contract'

import { routeCatalogChecker } from '../../../src/shared/http/route-catalog-check.js'
import { createHttpServer } from '../../../src/shared/http/fastify-http-boundary.js'
import type { IdGenerator } from '../../../src/shared/id/id-generator.js'

class FixedIdGenerator implements IdGenerator {
  public generate(): string {
    return 'route-check'
  }
}

const CATALOG: Readonly<Record<string, ApiRouteDefinition>> = {
  HEALTH: { method: 'GET', path: '/health', authenticated: false },
  ME: { method: 'GET', path: '/api/me', authenticated: true },
}

function buildServer() {
  return createHttpServer({ idGenerator: new FixedIdGenerator() })
}

async function noopHandler(): Promise<void> {}

void describe('routeCatalogChecker 启动路由目录对账', () => {
  void it('目录与注册完全一致时通过', async () => {
    const server = buildServer()
    const check = routeCatalogChecker(server, CATALOG)
    server.get('/health', noopHandler)
    server.get('/api/me', noopHandler)
    await server.ready()
    check.verify()
    await server.close()
  })

  void it('目录有而实际未注册时失败并列出遗漏端点', async () => {
    const server = buildServer()
    const check = routeCatalogChecker(server, CATALOG)
    server.get('/health', noopHandler)
    await server.ready()
    assert.throws(() => check.verify(), /契约路由未注册：GET \/api\/me（ME）/)
    await server.close()
  })

  void it('实际注册了目录外的裸路由时失败', async () => {
    const server = buildServer()
    const check = routeCatalogChecker(server, CATALOG)
    server.get('/health', noopHandler)
    server.get('/api/me', noopHandler)
    server.post('/api/legacy', noopHandler) // 绕过 bindRoute 的裸注册
    await server.ready()
    assert.throws(() => check.verify(), /不在契约目录中的注册：POST \/api\/legacy/)
    await server.close()
  })

  void it('method 与目录不符时同时报"缺目录项"与"多余注册"', async () => {
    const server = buildServer()
    const check = routeCatalogChecker(server, CATALOG)
    server.post('/health', noopHandler) // 目录是 GET /health
    await server.ready()
    assert.throws(
      () => check.verify(),
      /契约路由未注册：GET \/health（HEALTH）[\s\S]*不在契约目录中的注册：POST \/health/
    )
    await server.close()
  })
})
