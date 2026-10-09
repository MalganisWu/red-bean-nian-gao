import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, it } from 'node:test'

import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type SpanContext } from '@opentelemetry/api'
import { core, tracing } from '@opentelemetry/sdk-node'

import { OTelTracer, PreferredTraceIdGenerator } from '../../src/infra/observability/otel-tracer.js'
import { createObservabilityProvider } from '../../src/infra/observability/provider.js'
import type { ObservabilityProvider } from '../../src/infra/observability/provider.js'
import {
  SlogTracer,
  newTraceId,
  type StructuredLogRecord,
  type StructuredLogSink,
} from '../../src/infra/observability/slog-tracer.js'
import { W3CTraceContextExtractor } from '../../src/infra/observability/w3c-propagator.js'

class RecordingLogSink implements StructuredLogSink {
  public readonly records: StructuredLogRecord[] = []

  public write(record: StructuredLogRecord): void {
    this.records.push(record)
  }
}

class RetainingExporter implements tracing.SpanExporter {
  public readonly spans: tracing.ReadableSpan[] = []
  public shutdownCalls = 0

  public export(
    spans: tracing.ReadableSpan[],
    resultCallback: (result: core.ExportResult) => void
  ): void {
    this.spans.push(...spans)
    resultCallback({ code: core.ExportResultCode.SUCCESS })
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1
    return Promise.resolve()
  }
}

const providers: ObservabilityProvider[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(providers.splice(0).map((provider): Promise<void> => provider.shutdown()))
})

void describe('Slog tracing adapter', () => {
  void it('generates unique W3C-compatible trace IDs', () => {
    const first = newTraceId()
    const second = newTraceId()

    assert.match(first, /^[0-9a-f]{32}$/u)
    assert.notEqual(first, '0'.repeat(32))
    assert.notEqual(first, second)
  })

  void it('preserves the requested trace ID and builds nested spans', async () => {
    const sink = new RecordingLogSink()
    const spanIds = ['1111111111111111', '2222222222222222']
    const clockValues = [0, 0, 5, 8]
    const tracer = new SlogTracer({
      sink,
      traceIdGenerator: (): string => 'a'.repeat(32),
      spanIdGenerator: (): string => spanIds.shift() ?? 'f'.repeat(16),
      now: (): number => clockValues.shift() ?? 8,
    })
    const root = tracer.start({
      name: 'http.request',
      attributes: [{ key: 'trace.id', value: '0123456789abcdef0123456789abcdef' }],
    })

    await root.within(async (): Promise<void> => {
      const child = tracer.start({ name: 'pipeline.run', attributes: [] })
      await child.within(async (): Promise<void> => Promise.resolve())
      child.end()
    })
    root.end()

    const starts = sink.records.filter((record): boolean => record.message === 'span.start')
    const ends = sink.records.filter((record): boolean => record.message === 'span.end')
    assert.equal(starts[0]?.fields['trace_id'], '0123456789abcdef0123456789abcdef')
    assert.equal(starts[0]?.fields['span_id'], '1111111111111111')
    assert.equal(starts[1]?.fields['trace_id'], '0123456789abcdef0123456789abcdef')
    assert.equal(starts[1]?.fields['span_id'], '2222222222222222')
    assert.equal(starts[1]?.fields['parent_span_id'], '1111111111111111')
    assert.equal(ends[0]?.fields['duration_ms'], 5)
    assert.equal(ends[1]?.fields['duration_ms'], 8)
    assert.ok(ends.every((record): boolean => record.fields['status'] === 'ok'))
  })

  void it('emits trace_id once in every nested JSON log record', async () => {
    const sink = new RecordingLogSink()
    const tracer = new SlogTracer({
      sink,
      traceIdGenerator: (): string => 'a'.repeat(32),
      spanIdGenerator: (): string => '1'.repeat(16),
    })
    const root = tracer.start({
      name: 'http.request',
      attributes: [{ key: 'trace.id', value: '0123456789abcdef0123456789abcdef' }],
    })
    await root.within((): Promise<void> => {
      const child = tracer.start({ name: 'pipeline.run', attributes: [] })
      child.end()
      return Promise.resolve()
    })
    root.end()

    for (const record of sink.records) {
      assert.equal(JSON.stringify(record).match(/"trace_id"/gu)?.length, 1)
    }
  })
})

void describe('W3C trace context propagation', () => {
  void it('extracts a valid sampled remote parent and tracestate', () => {
    const extractor = new W3CTraceContextExtractor()
    const extracted = extractor.extract({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value',
    })

    assert.deepEqual(extracted, {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: 1,
      traceState: 'vendor=value',
    })
  })

  void it('ignores malformed traceparent headers', () => {
    const extractor = new W3CTraceContextExtractor()
    assert.equal(extractor.extract({ traceparent: 'malformed' }), undefined)
  })

  void it('injects a valid local context for outbound adapters', () => {
    const extractor = new W3CTraceContextExtractor()
    const headers: Record<string, string> = {}
    const context = trace.setSpanContext(
      ROOT_CONTEXT,
      spanContextWith('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7')
    )

    assert.equal(extractor.inject(context, headers), true)
    assert.equal(headers['traceparent'], '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
  })
})

void describe('OpenTelemetry tracing adapter', () => {
  void it('uses the requested trace ID, builds hierarchy and records failures', async () => {
    const exporter = new tracing.InMemorySpanExporter()
    const idGenerator = new PreferredTraceIdGenerator()
    const sdkProvider = new tracing.BasicTracerProvider({
      idGenerator,
      sampler: new tracing.AlwaysOnSampler(),
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    })
    const tracer = new OTelTracer(sdkProvider.getTracer('test'), idGenerator)
    const root = tracer.start({
      name: 'http.request',
      attributes: [
        { key: 'trace.id', value: '4bf92f3577b34da6a3ce929d0e0e4736' },
        { key: 'http.method', value: 'GET' },
      ],
    })

    await root.within((): Promise<void> => {
      const child = tracer.start({ name: 'pipeline.run', attributes: [] })
      child.setAttributes({ key: 'runtime.status', value: 'failed' })
      child.end(new Error('pipeline failed'))
      return Promise.resolve()
    })
    root.end()
    await sdkProvider.forceFlush()

    const ended = exporter.getFinishedSpans()
    const child = ended.find((span): boolean => span.name === 'pipeline.run')
    const rootSpan = ended.find((span): boolean => span.name === 'http.request')
    assert.ok(child !== undefined)
    assert.ok(rootSpan !== undefined)
    assert.equal(rootSpan.spanContext().traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
    assert.equal(rootSpan.kind, SpanKind.SERVER)
    assert.equal(child.parentSpanContext?.spanId, rootSpan.spanContext().spanId)
    assert.equal(child.spanContext().traceId, rootSpan.spanContext().traceId)
    assert.equal(child.attributes['runtime.status'], 'failed')
    assert.equal(child.status.code, SpanStatusCode.ERROR)
    assert.equal(child.status.message, 'pipeline failed')
    await sdkProvider.shutdown()
  })

  void it('inherits a remote W3C parent', async () => {
    const exporter = new tracing.InMemorySpanExporter()
    const idGenerator = new PreferredTraceIdGenerator()
    const sdkProvider = new tracing.BasicTracerProvider({
      idGenerator,
      sampler: new tracing.ParentBasedSampler({ root: new tracing.AlwaysOnSampler() }),
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    })
    const tracer = new OTelTracer(sdkProvider.getTracer('test'), idGenerator)
    const extracted = new W3CTraceContextExtractor().extract({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    })
    assert.ok(extracted !== undefined)
    const span = tracer.start({
      name: 'http.request',
      attributes: [
        { key: 'trace.id', value: extracted.traceId },
        { key: 'trace.parent_span_id', value: extracted.parentSpanId },
        { key: 'trace.flags', value: String(extracted.traceFlags) },
      ],
    })
    span.end()
    await sdkProvider.forceFlush()

    const ended = exporter.getFinishedSpans()
    assert.equal(ended.length, 1)
    assert.equal(ended[0]?.spanContext().traceId, extracted.traceId)
    assert.equal(ended[0]?.parentSpanContext?.spanId, extracted.parentSpanId)
    assert.equal(ended[0]?.parentSpanContext?.isRemote, true)
    await sdkProvider.shutdown()
  })
})

void describe('observability provider', () => {
  void it('uses slog by default without creating an exporter', () => {
    let exporterCreated = false
    const provider = createObservabilityProvider(
      { exporter: 'slog', serviceName: 'service', environment: '', sampleRatio: 1 },
      {
        exporterFactory: (): tracing.SpanExporter => {
          exporterCreated = true
          return new RetainingExporter()
        },
      }
    )
    providers.push(provider)

    assert.ok(provider.tracer() instanceof SlogTracer)
    assert.equal(exporterCreated, false)
  })

  void it('exports resource attributes and shuts down exactly once', async () => {
    const exporter = new RetainingExporter()
    const provider = createObservabilityProvider(
      {
        exporter: 'otlp',
        serviceName: 'red-bean-test',
        environment: 'test',
        sampleRatio: 1,
      },
      { exporterFactory: (): tracing.SpanExporter => exporter }
    )
    providers.push(provider)
    const span = provider.tracer().start({ name: 'pipeline.run', attributes: [] })
    span.end()
    await provider.shutdown()
    await provider.shutdown()

    assert.equal(exporter.spans.length, 1)
    assert.equal(exporter.spans[0]?.resource.attributes['service.name'], 'red-bean-test')
    assert.equal(exporter.spans[0]?.resource.attributes['deployment.environment.name'], 'test')
    assert.equal(exporter.spans[0]?.resource.attributes['telemetry.sdk.language'], 'nodejs')
    assert.equal(exporter.shutdownCalls, 1)
  })

  void it('honors an unsampled remote parent', async () => {
    const exporter = new RetainingExporter()
    const provider = createObservabilityProvider(
      { exporter: 'otlp', serviceName: 'service', environment: '', sampleRatio: 1 },
      { exporterFactory: (): tracing.SpanExporter => exporter }
    )
    providers.push(provider)
    const span = provider.tracer().start({
      name: 'http.request',
      attributes: [
        { key: 'trace.id', value: '4bf92f3577b34da6a3ce929d0e0e4736' },
        { key: 'trace.parent_span_id', value: '00f067aa0ba902b7' },
        { key: 'trace.flags', value: '0' },
      ],
    })
    span.end()
    await provider.shutdown()

    assert.equal(exporter.spans.length, 0)
  })

  void it('uses the standard OTLP HTTP environment and flushes on shutdown', async () => {
    let received = false
    const server = await listenForOtlpRequest((): void => {
      received = true
    })
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    const previousEndpoint = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] =
      `http://127.0.0.1:${String(address.port)}/v1/traces`

    try {
      const provider = createObservabilityProvider({
        exporter: 'otlp',
        serviceName: 'service',
        environment: '',
        sampleRatio: 1,
      })
      providers.push(provider)
      const span = provider.tracer().start({ name: 'pipeline.run', attributes: [] })
      span.end()
      await provider.shutdown()
      assert.equal(received, true)
    } finally {
      if (previousEndpoint === undefined) delete process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']
      else process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = previousEndpoint
      await closeServer(server)
    }
  })

  void it('rejects invalid configuration', () => {
    assert.throws(
      (): ObservabilityProvider =>
        createObservabilityProvider({
          exporter: 'zipkin',
          serviceName: 'service',
          environment: '',
          sampleRatio: 1,
        }),
      /unsupported exporter/u
    )
    assert.throws(
      (): ObservabilityProvider =>
        createObservabilityProvider({
          exporter: 'otlp',
          serviceName: '',
          environment: '',
          sampleRatio: 1,
        }),
      /service name/u
    )
    assert.throws(
      (): ObservabilityProvider =>
        createObservabilityProvider({
          exporter: 'otlp',
          serviceName: 'service',
          environment: '',
          sampleRatio: 0,
        }),
      /sample ratio/u
    )
  })
})

function listenForOtlpRequest(onRequest: () => void): Promise<Server> {
  return new Promise((resolve, reject): void => {
    const server = createServer((request, response): void => {
      const validPath = request.url === '/v1/traces'
      const contentType = request.headers['content-type'] ?? ''
      const validContentType = /application\/(?:json|x-protobuf)/u.test(contentType)
      let byteLength = 0
      request.on('data', (chunk: Buffer): void => {
        byteLength += chunk.byteLength
      })
      request.on('end', (): void => {
        if (validPath && validContentType && byteLength > 0) onRequest()
        response.writeHead(validPath && validContentType && byteLength > 0 ? 200 : 400)
        response.end()
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', (): void => resolve(server))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject): void => {
    server.close((error?: Error): void => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

function spanContextWith(traceId: string, spanId: string): SpanContext {
  return {
    traceId,
    spanId,
    traceFlags: 1,
    isRemote: false,
  }
}
