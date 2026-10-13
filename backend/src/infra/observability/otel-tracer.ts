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

import { newSpanId, newTraceId } from './structured-log-tracer.js'

const RESERVED_ATTRIBUTES = new Set([
  'trace.id',
  'runtime.trace_id',
  'trace.parent_span_id',
  'trace.flags',
  'trace.state',
])

/**
 * 让 HTTP 边缘生成的公开 trace ID 成为 OTel 根 trace ID。
 *
 * 存在的理由是一个对外承诺：响应头里的 `X-Trace-ID`、SSE 事件里的 `trace_id`
 * 与后端实际的 OTel Trace ID 必须是同一个值，否则用户报障时给的那个 ID 在观测后端里查不到。
 * 做法不是「事后对齐」，而是在建根 span 时就把这个 ID 交给 SDK 的 IDGenerator 使用。
 *
 * `within` 用 AsyncLocalStorage 承载「当前想要的 trace ID」，
 * 因为 `generateTraceId()` 是 SDK 同步调用的，没有参数通道可以传。
 */
export class PreferredTraceIdGenerator implements tracing.IdGenerator {
  readonly #preferred = new AsyncLocalStorage<string>()

  /**
   * 生成或沿用 trace ID，由 SDK 在建 span 时同步调用。
   * 绑定只在 `within` 的回调期间存在：进入回调时把「期望的 trace ID」放进 AsyncLocalStorage，
   * 回调结束即自动解绑，因此后续无关的根 span 不会继续复用这个 ID。
   * 上下文里没有值、或值格式非法时退回随机新 ID，从而保证返回值一定是合法 trace ID。
   * @returns 合法 trace ID；优先采用 `within` 绑定的值，否则新生成一个
   */
  public generateTraceId(): string {
    const preferred = this.#preferred.getStore()
    return preferred !== undefined && isValidTraceId(preferred) ? preferred : newTraceId()
  }

  /**
   * 生成 span ID。
   * 与 trace ID 不同，span ID 不需要与外部对齐，因此这里不查上下文、每次都是新的随机值——
   * 唯一要保证的是格式合法，否则 SDK 会静默丢弃这个 span。
   * @returns 新生成的合法 span ID
   */
  public generateSpanId(): string {
    return newSpanId()
  }

  /**
   * 在「以指定 trace ID 建根 span」的上下文里执行回调，绑定随回调作用域自动生效与解除。
   * 传入的 ID 非法（或为 `undefined`）时不绑定、直接执行回调，让 SDK 走随机 ID 分支——
   * 一个坏的外部 trace ID 只应导致链路断开，不该让请求失败。
   * @param traceId - 期望的根 trace ID，通常来自入站请求头；格式不合法则被忽略
   * @param operation - 回调；其返回值与抛出的异常都原样透传
   * @returns 回调的返回值
   */
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

  /**
   * 建 span。父上下文按三级回退解析：**本地活跃 span → 远端父（由属性还原）→ 根**。
   *
   * 只有在**两级都没有**（即这是一个根 span）时才把 `trace.id` 交给 IDGenerator——
   * 子 span 的 trace ID 必须继承父级，此时再指定会切断链路。
   * 远端父只在没有本地活跃 span 时考虑：本地上下文才是更近的事实。
   *
   * 状态绑定不在这里发生：本方法只建 span，真正把它设为活跃的是返回对象上的 `within`，
   * 因此「建 span」与「进入其上下文」是两个可以分开的步骤。
   * @param start - 建 span 所需的名字与属性；名字还决定 span kind，属性中的保留键会被丢弃
   * @returns 新建的 span 句柄；调用方负责最终调用其 `end`
   */
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

  /** 把本 span 设为异步上下文里的活跃 span，使期间产生的子 span 自动挂到它下面。 */
  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return this.#active.run(this.#context, operation)
  }

  /** 幂等收尾；带错误时同时记录异常与 ERROR 状态，两者在观测后端是不同的检索维度。 */
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

/**
 * 从属性里还原远端父上下文（跨进程传播进来的 `traceparent`）。
 * 只要 id 缺失或格式非法就返回 undefined 并退回根 span——**绝不因为一个坏 header 让请求失败**：
 * 观测是旁路，坏掉的传播信息只该让链路断开，不该影响业务。
 * `trace.flags` 缺省为已采样（上游发过来了通常就是想被采）。
 */
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
