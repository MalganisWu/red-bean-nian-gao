import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { describe, it } from 'node:test'
import { registerChatRoutes } from '../../../../../src/modules/agent/http-api.js'
import { streamFrames } from '../../../../../src/modules/agent/chat/controller/chat-stream.js'
import { DefaultChatService } from '../../../../../src/modules/agent/chat/service/default-chat-service.js'
import { createHttpServer } from '../../../../../src/shared/http/fastify-http-boundary.js'
import type { ProductStreamEvent } from '../../../../../src/modules/agent/run/model/agent-run.js'
import {
  SequentialIds,
  TestAuth,
  TestCancelRegistry,
  CapturingRunService,
  DisconnectCapturingChat,
  SlowConsumerChat,
  testHandle,
  waitForAbort,
} from './chat-routes-test-support.js'

void describe('chat request and SSE parity', () => {
  void it('uses independent HTTP, trace and run IDs and starts SSE with trace_id', async () => {
    const ids = new SequentialIds()
    const runner = new CapturingRunService()
    const cancellations = new TestCancelRegistry()
    const server = createHttpServer({
      idGenerator: ids,
      traceIdGenerator: (): string => '0123456789abcdef0123456789abcdef',
    })
    registerChatRoutes(server, {
      chat: new DefaultChatService({
        runService: runner,
        cancelRegistry: cancellations,
        idGenerator: ids,
      }),
      authService: new TestAuth(),
    })
    await server.ready()

    const response = await server.inject({
      method: 'POST',
      url: '/api/agent/chat',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'hello' }], session_id: 'SESSION_1' },
    })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /event: start/u)
    assert.match(response.body, /"trace_id":"0123456789abcdef0123456789abcdef"/u)
    assert.equal(runner.request?.traceId, '0123456789abcdef0123456789abcdef')
    assert.notEqual(runner.request?.runId, response.headers['x-request-id'])
    assert.equal(cancellations.wrappedKey, `USER_1:${runner.request?.runId ?? ''}`)
    assert.equal(cancellations.deregisteredKey, cancellations.wrappedKey)
    assert.equal(response.body.match(/event: done/gu)?.length, 1)
    assert.match(response.body, /"tokens_used":3/u)
    await server.close()
  })

  void it('merges adjacent reason fragments and keeps an idle stream alive', async () => {
    const events: AsyncIterable<ProductStreamEvent> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProductStreamEvent> {
        yield { type: 'reason', content: '先分析', step: 1, timestamp: 10 }
        yield { type: 'reason', content: '，再执行', step: 1, timestamp: 11 }
        await new Promise<void>((resolve): void => {
          setTimeout(resolve, 12)
        })
        yield { type: 'done', tokensUsed: 8, sessionId: 'SESSION_1' }
      },
    }
    const frames: string[] = []
    for await (const frame of streamFrames(
      testHandle(events),
      {
        type: 'start',
        requestId: 'RUN_1',
        sessionId: 'SESSION_1',
        traceId: '0123456789abcdef0123456789abcdef',
      },
      new AbortController().signal,
      5,
      (): number => 123
    )) {
      frames.push(frame)
    }

    assert.equal(frames.filter((frame): boolean => frame.startsWith('event: reason')).length, 1)
    assert.match(frames.join(''), /"content":"先分析，再执行"/u)
    assert.equal(frames.filter((frame): boolean => frame.startsWith('event: done')).length, 1)
    assert.equal(
      frames.some((frame): boolean => frame.includes('event: heartbeat')),
      true
    )
  })

  void it('真实 socket 断开时以 client_disconnected 关闭运行', async () => {
    const chat = new DisconnectCapturingChat()
    const server = createHttpServer({ idGenerator: new SequentialIds() })
    registerChatRoutes(server, { chat, authService: new TestAuth() })
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')

    try {
      await new Promise<void>((resolve, reject): void => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/agent/chat',
            method: 'POST',
            headers: {
              authorization: 'Bearer token',
              'content-type': 'application/json',
            },
          },
          (response): void => {
            response.once('data', (): void => {
              response.destroy()
              resolve()
            })
          }
        )
        request.once('error', reject)
        request.end(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }))
      })
      await chat.waitUntilClosed()
      assert.equal(chat.command?.signal.aborted, true)
      assert.equal(chat.closeReason, 'client_disconnected')
    } finally {
      await server.close()
    }
  })

  void it('真实 socket 慢消费者触发有界队列保护', async () => {
    const chat = new SlowConsumerChat()
    const server = createHttpServer({ idGenerator: new SequentialIds() })
    registerChatRoutes(server, { chat, authService: new TestAuth() })
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')

    let response: IncomingMessage | undefined
    try {
      response = await new Promise((resolve, reject): void => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/agent/chat',
            method: 'POST',
            headers: {
              authorization: 'Bearer token',
              'content-type': 'application/json',
            },
          },
          (incoming): void => {
            incoming.pause()
            resolve(incoming)
          }
        )
        request.once('error', reject)
        request.end(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }))
      })
      const handle = chat.handle
      if (handle === undefined) throw new Error('chat handle was not created')
      await waitForAbort(handle.signal)
      assert.match(String(handle.signal.reason), /事件队列超过容量/u)
    } finally {
      response?.destroy()
      await server.close()
    }
  })
})
