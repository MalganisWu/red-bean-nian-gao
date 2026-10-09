import type { IncomingHttpHeaders } from 'node:http'

import {
  ROOT_CONTEXT,
  isSpanContextValid,
  trace,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api'
import { core } from '@opentelemetry/sdk-node'

import type { TraceContextExtractorPort } from '../../shared/http/fastify-http-boundary.js'

export interface ExtractedW3CTraceContext {
  readonly traceId: string
  readonly parentSpanId: string
  readonly traceFlags: number
  readonly traceState?: string | undefined
}

const headerGetter: TextMapGetter<IncomingHttpHeaders> = {
  keys(carrier: IncomingHttpHeaders): string[] {
    return Object.keys(carrier)
  },
  get(carrier: IncomingHttpHeaders, key: string): string | string[] | undefined {
    return carrier[key.toLowerCase()]
  },
}

const headerSetter: TextMapSetter<Record<string, string>> = {
  set(carrier: Record<string, string>, key: string, value: string): void {
    carrier[key.toLowerCase()] = value
  },
}

/** `TraceContextExtractorPort` 的 W3C 实现；只校验传播格式，不把 Trace 身份当作授权凭证。 */
export class W3CTraceContextExtractor implements TraceContextExtractorPort {
  readonly #propagator = new core.W3CTraceContextPropagator()

  public extract(headers: IncomingHttpHeaders): ExtractedW3CTraceContext | undefined {
    const extracted = this.#propagator.extract(ROOT_CONTEXT, headers, headerGetter)
    const spanContext = trace.getSpanContext(extracted)
    if (
      spanContext === undefined ||
      !isSpanContextValid(spanContext) ||
      spanContext.isRemote !== true
    ) {
      return undefined
    }
    const traceState = spanContext.traceState?.serialize() ?? ''
    return {
      traceId: spanContext.traceId,
      parentSpanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      ...(traceState === '' ? {} : { traceState }),
    }
  }

  public inject(context: Context, headers: Record<string, string>): boolean {
    const spanContext = trace.getSpanContext(context)
    if (
      spanContext === undefined ||
      !isSpanContextValid(spanContext) ||
      spanContext.isRemote === true
    ) {
      return false
    }
    this.#propagator.inject(context, headers, headerSetter)
    return true
  }
}
