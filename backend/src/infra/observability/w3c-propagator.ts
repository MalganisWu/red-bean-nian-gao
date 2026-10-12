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

/** 从 `traceparent` / `tracestate` 解析出的上下文；`traceFlags` 已转成数字。 */
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

  /**
   * 从入站 header 解析远端父链路。
   * 额外要求 `isRemote === true`：传播器在没有 `traceparent` 时也会返回一个本地上下文的 span，
   * 那不是「远端父」，当成远端父会让每次请求都被误判为接续了外部链路。
   */
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

  /**
   * 把当前上下文写进出站 header。**拒绝注入远端上下文**：
   * 那意味着本进程只是把上游的链路原样转手，注入一份并非自己产生的 `traceparent`
   * 会让下游把本进程误认为链路中的一段。
   * 返回 `false` 表示没注入（上下文无效或本就是远端的），调用方据此可以跳过写 header。
   */
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
