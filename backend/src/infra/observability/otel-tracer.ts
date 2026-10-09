import { AsyncLocalStorage } from 'node:async_hooks'

import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  createTraceState,
  isValidSpanId,
  isValidTraceId,
  trace,
  type Attributes,
  type Context,
  type Span as ApiSpan,
  type SpanContext,
  type Tracer as ApiTracer,
} from '@opentelemetry/api'
import type { tracing } from '@opentelemetry/sdk-node'
import type { TraceAttribute, TraceSpan, TracerPort } from '../../shared/observability/tracer.js'

import { newSpanId, newTraceId } from './slog-tracer.js'

const RESERVED_ATTRIBUTES = new Set([
  'trace.id',
  'runtime.trace_id',
  'trace.parent_span_id',
  'trace.flags',
  'trace.state',
])

/** 让 HTTP 边缘生成的公开 trace ID 成为 OTel 根 trace ID。 */
export class PreferredTraceIdGenerator implements tracing.IdGenerator {
  readonly #preferred = new AsyncLocalStorage<string>()

  public generateTraceId(): string {
    const preferred = this.#preferred.getStore()
    return preferred !== undefined && isValidTraceId(preferred) ? preferred : newTraceId()
  }

  public generateSpanId(): string {
    return newSpanId()
  }

  public within<TValue>(traceId: string | undefined, operation: () => TValue): TValue {
    if (traceId === undefined || !isValidTraceId(traceId)) return operation()
    return this.#preferred.run(traceId, operation)
  }
}

/** 将 Runtime 中性的 tracing 契约适配到 OpenTelemetry API。 */
export class OTelTracer implements TracerPort {
  readonly #tracer: ApiTracer
  readonly #idGenerator: PreferredTraceIdGenerator
  readonly #active = new AsyncLocalStorage<Context>()

  public constructor(tracer: ApiTracer, idGenerator: PreferredTraceIdGenerator) {
    this.#tracer = tracer
    this.#idGenerator = idGenerator
  }

  public start(start: {
    readonly name: string
    readonly attributes: readonly TraceAttribute[]
  }): TraceSpan {
    const activeContext = this.#active.getStore()
    const remoteParent =
      activeContext === undefined ? remoteParentContext(start.attributes) : undefined
    const parentContext = activeContext ?? remoteParent ?? ROOT_CONTEXT
    const options = {
      kind: spanKind(start.name),
      attributes: otelAttributes(start.attributes),
    }
    const createSpan = (): ApiSpan => this.#tracer.startSpan(start.name, options, parentContext)
    const requestedTraceId =
      attributeValue(start.attributes, 'trace.id') ??
      attributeValue(start.attributes, 'runtime.trace_id')
    const span =
      activeContext === undefined && remoteParent === undefined
        ? this.#idGenerator.within(requestedTraceId, createSpan)
        : createSpan()
    const spanContext = trace.setSpan(parentContext, span)
    return new OTelSpan(span, spanContext, this.#active)
  }
}

class OTelSpan implements TraceSpan {
  readonly #span: ApiSpan
  readonly #context: Context
  readonly #active: AsyncLocalStorage<Context>
  #ended = false

  public constructor(span: ApiSpan, context: Context, active: AsyncLocalStorage<Context>) {
    this.#span = span
    this.#context = context
    this.#active = active
  }

  public setAttributes(...attributes: readonly TraceAttribute[]): void {
    this.#span.setAttributes(otelAttributes(attributes))
  }

  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return this.#active.run(this.#context, operation)
  }

  public end(error?: Error): void {
    if (this.#ended) return
    this.#ended = true
    if (error !== undefined) {
      this.#span.recordException(error)
      this.#span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    }
    this.#span.end()
  }
}

function remoteParentContext(attributes: readonly TraceAttribute[]): Context | undefined {
  const traceId =
    attributeValue(attributes, 'trace.id') ?? attributeValue(attributes, 'runtime.trace_id')
  const spanId = attributeValue(attributes, 'trace.parent_span_id')
  if (traceId === undefined || spanId === undefined) return undefined
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return undefined
  const flagsText = attributeValue(attributes, 'trace.flags')
  const parsedFlags = flagsText === undefined ? TraceFlags.SAMPLED : Number.parseInt(flagsText, 10)
  const traceFlags =
    Number.isInteger(parsedFlags) && parsedFlags >= 0 && parsedFlags <= 255
      ? parsedFlags
      : TraceFlags.NONE
  const traceStateText = attributeValue(attributes, 'trace.state')
  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags,
    isRemote: true,
    ...(traceStateText === undefined || traceStateText === ''
      ? {}
      : { traceState: createTraceState(traceStateText) }),
  }
  return trace.setSpanContext(ROOT_CONTEXT, spanContext)
}

function spanKind(name: string): SpanKind {
  if (name === 'http.request') return SpanKind.SERVER
  if (name === 'llm.stream') return SpanKind.CLIENT
  return SpanKind.INTERNAL
}

function otelAttributes(attributes: readonly TraceAttribute[]): Attributes {
  const result: Attributes = {}
  for (const attribute of attributes) {
    const key = attribute.key.trim()
    if (key !== '' && !RESERVED_ATTRIBUTES.has(key)) result[key] = attribute.value
  }
  return result
}

function attributeValue(attributes: readonly TraceAttribute[], key: string): string | undefined {
  return attributes.find((attribute): boolean => attribute.key === key)?.value || undefined
}
