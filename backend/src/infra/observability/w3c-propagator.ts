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
   *
   * 解析失败一律返回 `undefined` 而不是抛错：观测是旁路，坏掉的 `traceparent`
   * 只应让链路断开，绝不能影响请求本身。
   * @param headers - 入站 header；键名大小写不敏感，缺失 `traceparent` 时视为无远端父
   * @returns 解析出的远端父上下文；header 缺失、格式非法或不是远端来源时为 `undefined`
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
   * @param context - 待注入的上下文；通常取自当前活跃 span，其 span 必须是本地产生的
   * @param headers - 写入目标，会被就地修改；键名统一转小写，未注入时保持原样
   * @returns 是否真的写入了 `traceparent`；`false` 表示未做任何修改
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
