import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  authenticatedPrincipal,
  authenticatedRequest,
} from '../../../src/shared/http/authenticated-request.js'
import type { TokenValidator } from '../../../src/shared/authentication/token-validator.js'
import { createHttpServer } from '../../../src/shared/http/fastify-http-boundary.js'

class StubTokenValidator implements TokenValidator {
  public token: string | undefined

  public validateToken(token: string): Promise<string> {
    this.token = token
    return Promise.resolve('USER_principal')
  }
}

const idGenerator = { generate: (): string => 'REQ_principal' }

void describe('authenticated request principal', () => {
  void it('binds a typed principal after validating the bearer token', async () => {
    const validator = new StubTokenValidator()
    const server = createHttpServer({ idGenerator })
    server.get(
      '/principal',
      { preHandler: authenticatedRequest(validator) },
      async (request, reply): Promise<void> => {
        await reply.status(200).send(authenticatedPrincipal(request))
      }
    )

    const response = await server.inject({
      method: 'GET',
      url: '/principal',
      headers: { authorization: 'Bearer access-token' },
    })

    assert.equal(validator.token, 'access-token')
    assert.deepEqual(response.json(), { userId: 'USER_principal' })
    await server.close()
  })

  void it('rejects access when no principal was bound', async () => {
    const server = createHttpServer({ idGenerator })
    server.get('/principal', async (request, reply): Promise<void> => {
      await reply.status(200).send(authenticatedPrincipal(request))
    })

    const response = await server.inject({ method: 'GET', url: '/principal' })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { code: 4002, message: '未授权', data: null })
    await server.close()
  })
})
