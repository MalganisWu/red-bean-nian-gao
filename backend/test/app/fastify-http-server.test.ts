import assert from 'node:assert/strict'
import { once } from 'node:events'
import { describe, it } from 'node:test'

import fastify from 'fastify'

import { FastifyHttpServer } from '../../src/app/fastify-http-server.js'

void describe('Fastify HTTP server lifecycle adapter', () => {
  void it('keeps listen pending until graceful shutdown completes', async () => {
    const server = fastify({ logger: false })
    const adapter = new FastifyHttpServer(server, { host: '127.0.0.1', port: 0 })
    const listening = once(server.server, 'listening')

    let settled = false
    const run = adapter.listen().finally((): void => {
      settled = true
    })
    await listening
    assert.equal(settled, false)

    await adapter.shutdown(new AbortController().signal)
    await run
    assert.equal(settled, true)
  })

  void it('rejects invalid port values before opening a socket', () => {
    const server = fastify({ logger: false })
    assert.throws(
      () => new FastifyHttpServer(server, { host: '127.0.0.1', port: 'invalid' }),
      /端口/
    )
  })
})
