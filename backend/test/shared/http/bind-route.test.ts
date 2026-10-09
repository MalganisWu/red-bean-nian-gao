import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { API_ROUTES } from '@red-bean/api-contract'

import { bindRoute } from '../../../src/shared/http/bind-route.js'
import { createHttpServer } from '../../../src/shared/http/fastify-http-boundary.js'
import type { IdGenerator } from '../../../src/shared/id/id-generator.js'

class FixedIdGenerator implements IdGenerator {
  public generate(): string {
    return 'route-test'
  }
}

function buildServer() {
  return createHttpServer({ idGenerator: new FixedIdGenerator() })
}

/** 异步空 handler：注册时不关心业务语义。 */
async function noopHandler(): Promise<void> {}

async function noopAuth(): Promise<void> {}

void describe('bindRoute 端点目录绑定', () => {
  void it('authenticated 路由缺少 auth 钩子时启动即失败（fail-fast）', () => {
    const server = buildServer()
    assert.throws(
      () => bindRoute(server, API_ROUTES.ME, { handler: noopHandler }),
      /authenticated=true.*auth/
    )
  })

  void it('公开端点（authenticated=false）挂 auth 钩子时启动即失败', () => {
    const server = buildServer()
    assert.throws(
      () => bindRoute(server, API_ROUTES.HEALTH, { auth: noopAuth, handler: noopHandler }),
      /authenticated=false.*auth/
    )
  })

  void it('从命名表取 method/path 注册，认证钩子按声明顺序前置', async () => {
    const server = buildServer()
    bindRoute(server, API_ROUTES.HEALTH, { handler: noopHandler })
    bindRoute(server, API_ROUTES.ME, { auth: noopAuth, handler: noopHandler })
    await server.ready()

    const printed = server.printRoutes({ commonPrefix: false })
    assert.match(printed, /\/api\/me \(GET/)
    assert.match(printed, /\/health \(GET/)
    await server.close()
  })
})
