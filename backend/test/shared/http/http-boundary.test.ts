import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'

import type { Span, SpanStart, Tracer } from 'red-bean-qing-tuan/observability'

import {
  FixedWindowRateLimiter,
  createHttpServer,
  requestTraceId,
  type TraceContextExtractorPort,
} from '../../../src/shared/http/fastify-http-boundary.js'
import { loggedInternalError, validationError } from '../../../src/shared/http/error-mapper.js'

class FixedIdGenerator {
  public readonly prefixes: string[] = []

  public generate(prefix: string): string {
    this.prefixes.push(prefix)
    return `${prefix}_generated`
  }
}

class RecordingSpan implements Span {
  public readonly attributes = new Map<string, string>()
  public ended = false
  public error: Error | undefined
  readonly #within: () => void

  public constructor(start: SpanStart, within: () => void) {
    for (const attribute of start.attributes) {
      this.attributes.set(attribute.key, attribute.value)
    }
    this.#within = within
  }

  public setAttributes(
    ...attributes: readonly { readonly key: string; readonly value: string }[]
  ): void {
    for (const attribute of attributes) this.attributes.set(attribute.key, attribute.value)
  }

  public async within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    this.#within()
    return operation()
  }

  public end(error?: Error): void {
    this.ended = true
    this.error = error
  }
}

class RecordingTracer implements Tracer {
  public startValue: SpanStart | undefined
  public span: RecordingSpan | undefined
  public withinCalled = false

  public start(start: SpanStart): Span {
    this.startValue = start
    this.span = new RecordingSpan(start, (): void => {
      this.withinCalled = true
    })
    return this.span
  }
}

void describe('Fastify HTTP boundary parity', () => {
  void it('generates or reuses request IDs and exposes a request logger', async () => {
    const generator = new FixedIdGenerator()
    const server = createHttpServer({ idGenerator: generator })
    server.get('/probe', async (request, reply): Promise<void> => {
      assert.equal(typeof request.log.info, 'function')
      await reply.status(204).send()
    })

    const generated = await server.inject({ method: 'GET', url: '/probe' })
    assert.equal(generated.statusCode, 204)
    assert.equal(generated.headers['x-request-id'], 'REQ_generated')
    assert.deepEqual(generator.prefixes, ['REQ'])

    const upstream = await server.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'REQ_upstream_123' },
    })
    assert.equal(upstream.headers['x-request-id'], 'REQ_upstream_123')
    assert.deepEqual(generator.prefixes, ['REQ'])
    await server.close()
  })

  void it('enforces the JSON limit without applying it to multipart bodies', async () => {
    const server = createHttpServer({
      idGenerator: new FixedIdGenerator(),
      jsonBodyLimit: 16,
    })
    server.post('/json', async (_request, reply): Promise<void> => {
      await reply.status(200).send({ code: 200 })
    })
    server.post('/upload', async (_request, reply): Promise<void> => {
      await reply.status(204).send()
    })

    const withinLimit = await server.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    })
    assert.equal(withinLimit.statusCode, 200)

    const overLimit = await server.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{"value":"0123456789"}',
    })
    assert.equal(overLimit.statusCode, 413)
    assert.deepEqual(overLimit.json(), {
      code: 4001,
      message: 'JSON 请求体不能超过 16 字节',
      data: null,
    })

    const boundary = 'boundary-for-test'
    const multipartPayload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="value"',
      '',
      'x'.repeat(128),
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const multipart = await server.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload,
    })
    assert.equal(multipart.statusCode, 204)
    await server.close()
  })

  void it('matches allow-list, wildcard, preflight and empty CORS behavior', async () => {
    const allowed = createHttpServer({
      idGenerator: new FixedIdGenerator(),
      corsOrigins: 'http://localhost:5173, https://app.example.com',
    })
    let optionsCalled = false
    allowed.get('/probe', async (_request, reply): Promise<void> => {
      await reply.status(200).send()
    })
    allowed.options('/probe', async (_request, reply): Promise<void> => {
      optionsCalled = true
      await reply.status(200).send()
    })
    const accepted = await allowed.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://app.example.com' },
    })
    assert.equal(accepted.headers['access-control-allow-origin'], 'https://app.example.com')
    assert.equal(accepted.headers['access-control-allow-credentials'], 'true')
    const rejected = await allowed.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://evil.example.com' },
    })
    assert.equal(rejected.headers['access-control-allow-origin'], undefined)
    const preflight = await allowed.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: { origin: 'http://localhost:5173' },
    })
    assert.equal(preflight.statusCode, 204)
    assert.equal(optionsCalled, false)
    await allowed.close()

    const wildcard = createHttpServer({
      idGenerator: new FixedIdGenerator(),
      corsOrigins: '*',
    })
    wildcard.get('/probe', async (_request, reply): Promise<void> => {
      await reply.status(200).send()
    })
    const anyOrigin = await wildcard.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://anything.example.com' },
    })
    assert.equal(anyOrigin.headers['access-control-allow-origin'], '*')
    await wildcard.close()

    const empty = createHttpServer({ idGenerator: new FixedIdGenerator(), corsOrigins: '' })
    empty.get('/probe', async (_request, reply): Promise<void> => {
      await reply.status(200).send()
    })
    const passthrough = await empty.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://anything.example.com' },
    })
    assert.equal(passthrough.statusCode, 200)
    assert.equal(passthrough.headers['access-control-allow-origin'], undefined)
    await empty.close()
  })

  void it('returns the stable error envelope, logs hidden causes and handles missing routes', async () => {
    let logs = ''
    const stream = new Writable({
      write(chunk, _encoding, callback): void {
        logs += String(chunk)
        callback()
      },
    })
    const server = createHttpServer({
      idGenerator: new FixedIdGenerator(),
      logger: { level: 'debug', stream },
    })
    server.get('/validation', (): never => {
      throw validationError('字段不能为空')
    })
    server.get('/internal', (): never => {
      throw loggedInternalError('load failed', new Error('database unavailable'))
    })
    server.get('/ok', async (_request, reply): Promise<void> => {
      await reply.status(200).send({ code: 200, message: 'ok', data: null })
    })

    const validation = await server.inject({ method: 'GET', url: '/validation' })
    assert.equal(validation.statusCode, 400)
    assert.deepEqual(validation.json(), { code: 4001, message: '字段不能为空', data: null })
    const internal = await server.inject({ method: 'GET', url: '/internal' })
    assert.equal(internal.statusCode, 500)
    assert.deepEqual(internal.json(), { code: 5000, message: '服务器内部错误', data: null })
    for (const expected of ['REQ_generated', 'load failed', 'database unavailable']) {
      assert.match(logs, new RegExp(expected))
    }
    const ok = await server.inject({ method: 'GET', url: '/ok' })
    assert.deepEqual(ok.json(), { code: 200, message: 'ok', data: null })
    const missing = await server.inject({ method: 'GET', url: '/missing' })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { code: 4004, message: '资源不存在', data: null })
    await server.close()
  })

  void it('limits by client IP with a bounded Retry-After response', async () => {
    const server = createHttpServer({ idGenerator: new FixedIdGenerator() })
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMilliseconds: 60_000,
      now: (): number => 1_000,
    })
    server.post('/login', {
      preHandler: limiter.preHandler(),
      handler: async (_request, reply): Promise<void> => {
        await reply.status(200).send({ code: 200 })
      },
    })

    const first = await server.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: '192.0.2.1',
    })
    assert.equal(first.statusCode, 200)
    const second = await server.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: '192.0.2.1',
    })
    assert.equal(second.statusCode, 429)
    assert.equal(second.headers['retry-after'], '60')
    assert.deepEqual(second.json(), {
      code: 4009,
      message: '请求过于频繁，请稍后再试',
      data: null,
    })
    await server.close()
  })

  void it('creates an independent trace or inherits a validated W3C parent', async () => {
    const generatedTracer = new RecordingTracer()
    const generatedServer = createHttpServer({
      idGenerator: new FixedIdGenerator(),
      tracer: generatedTracer,
      traceIdGenerator: (): string => '0123456789abcdef0123456789abcdef',
    })
    let seenTrace = ''
    generatedServer.get('/probe', async (request, reply): Promise<void> => {
      seenTrace = requestTraceId(request)
      await reply.status(202).send()
    })
    const generated = await generatedServer.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'REQ_upstream' },
    })
    assert.equal(seenTrace, '0123456789abcdef0123456789abcdef')
    assert.equal(generated.headers['x-trace-id'], seenTrace)
    assert.equal(generatedTracer.startValue?.name, 'http.request')
    assert.equal(generatedTracer.withinCalled, true)
    assert.equal(generatedTracer.span?.attributes.get('request.id'), 'REQ_upstream')
    assert.equal(generatedTracer.span?.attributes.get('trace.id'), seenTrace)
    assert.equal(generatedTracer.span?.attributes.get('http.route'), '/probe')
    assert.equal(generatedTracer.span?.attributes.get('http.status_code'), '202')
    assert.equal(generatedTracer.span?.ended, true)
    assert.equal(generatedTracer.span?.error, undefined)
    await generatedServer.close()

    let generatedFallback = false
    let extracted = false
    const inheritedTracer = new RecordingTracer()
    const extractor: TraceContextExtractorPort = {
      extract(headers): {
        readonly traceId: string
        readonly parentSpanId: string
        readonly traceFlags: number
        readonly traceState: string
      } {
        extracted = headers['traceparent'] !== undefined
        return {
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          parentSpanId: '00f067aa0ba902b7',
          traceFlags: 1,
          traceState: 'vendor=value',
        }
      },
    }
    const inheritedServer = createHttpServer({
      idGenerator: new FixedIdGenerator(),
      tracer: inheritedTracer,
      traceIdGenerator: (): string => {
        generatedFallback = true
        return 'unused'
      },
      traceContextExtractor: extractor,
    })
    inheritedServer.get('/probe', async (_request, reply): Promise<void> => {
      await reply.status(204).send()
    })
    const inherited = await inheritedServer.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    })
    assert.equal(extracted, true)
    assert.equal(generatedFallback, false)
    assert.equal(inherited.headers['x-trace-id'], '4bf92f3577b34da6a3ce929d0e0e4736')
    assert.equal(inheritedTracer.span?.attributes.get('trace.parent_span_id'), '00f067aa0ba902b7')
    assert.equal(inheritedTracer.span?.attributes.get('trace.flags'), '1')
    assert.equal(inheritedTracer.span?.attributes.get('trace.state'), 'vendor=value')
    await inheritedServer.close()
  })
})
