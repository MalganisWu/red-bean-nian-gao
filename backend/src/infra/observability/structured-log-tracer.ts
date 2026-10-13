import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

import type { TraceAttribute, TraceSpan, TracerPort } from '../../shared/observability/tracer.js'

/** 只有三档：span 开始固定记 debug，结束按成败记 info / error。 */
export type StructuredLogLevel = 'debug' | 'info' | 'error'
/** 字段值限标量：采集器要能直接索引，嵌套结构会退化成不可查询的字符串。 */
export type StructuredLogValue = string | number

/** 一条 span 日志；字段平铺，键名即索引键（`trace_id`、`span.name` 等）。 */
export interface StructuredLogRecord {
  readonly level: StructuredLogLevel
  readonly message: string
  readonly fields: Readonly<Record<string, StructuredLogValue>>
}

/** 输出目标；默认实现往 stdout 写一行 JSON。 */
export interface StructuredLogSink {
  write(record: StructuredLogRecord): void
}

/** 构造选项；全部可注入，测试因此能在不碰 stdout、不依赖真实随机源的前提下断言 span。 */
export interface StructuredLogTracerOptions {
  readonly sink?: StructuredLogSink | undefined
  readonly traceIdGenerator?: (() => string) | undefined
  readonly spanIdGenerator?: (() => string) | undefined
  readonly now?: (() => number) | undefined
}

interface ActiveStructuredLogSpan {
  readonly traceId: string
  readonly spanId: string
}

class JsonConsoleLogSink implements StructuredLogSink {
  public write(record: StructuredLogRecord): void {
    process.stdout.write(`${JSON.stringify(record)}\n`)
  }
}

/** Runtime tracing 契约的零依赖结构化日志实现。 */
export class StructuredLogTracer implements TracerPort {
  readonly #active = new AsyncLocalStorage<ActiveStructuredLogSpan>()
  readonly #sink: StructuredLogSink
  readonly #traceIdGenerator: () => string
  readonly #spanIdGenerator: () => string
  readonly #now: () => number

  public constructor(options: StructuredLogTracerOptions = {}) {
    this.#sink = options.sink ?? new JsonConsoleLogSink()
    this.#traceIdGenerator = options.traceIdGenerator ?? newTraceId
    this.#spanIdGenerator = options.spanIdGenerator ?? newSpanId
    this.#now = options.now ?? Date.now
  }

  /**
   * 建一条 span 日志并立即记下开始事件。
   * trace ID 按三级回退解析：**本地活跃 span → 远端父属性 → 新生成**，因此同一请求内的
   * 子 span 会沿用父 span 的 trace ID，而无父可依时才开一条新链路。
   * 状态绑定不在这一步发生：本方法只建 span，真正把它设为活跃的是返回对象上的 `within`。
   * @param start - 建 span 所需的名字与属性；属性里的 `trace.id` / `trace.parent_span_id` 参与父级解析
   * @returns 新建的 span 句柄；调用方负责最终调用其 `end` 以写出结束事件
   */
  public start(start: {
    readonly name: string
    readonly attributes: readonly TraceAttribute[]
  }): TraceSpan {
    const parent = this.#active.getStore()
    const traceId =
      parent?.traceId ??
      attributeValue(start.attributes, 'trace.id') ??
      attributeValue(start.attributes, 'runtime.trace_id') ??
      this.#traceIdGenerator()
    const parentSpanId =
      parent?.spanId ?? attributeValue(start.attributes, 'trace.parent_span_id') ?? ''
    const state: ActiveStructuredLogSpan = { traceId, spanId: this.#spanIdGenerator() }
    const span = new StructuredLogSpan({
      start,
      state,
      parentSpanId,
      sink: this.#sink,
      active: this.#active,
      startedAt: this.#now(),
      now: this.#now,
    })
    span.writeStart()
    return span
  }
}

interface StructuredLogSpanOptions {
  readonly start: { readonly name: string; readonly attributes: readonly TraceAttribute[] }
  readonly state: ActiveStructuredLogSpan
  readonly parentSpanId: string
  readonly sink: StructuredLogSink
  readonly active: AsyncLocalStorage<ActiveStructuredLogSpan>
  readonly startedAt: number
  readonly now: () => number
}

class StructuredLogSpan implements TraceSpan {
  readonly #name: string
  readonly #state: ActiveStructuredLogSpan
  readonly #parentSpanId: string
  readonly #sink: StructuredLogSink
  readonly #active: AsyncLocalStorage<ActiveStructuredLogSpan>
  readonly #startedAt: number
  readonly #now: () => number
  readonly #attributes: Map<string, string>
  #ended = false

  public constructor(options: StructuredLogSpanOptions) {
    this.#name = options.start.name
    this.#state = options.state
    this.#parentSpanId = options.parentSpanId
    this.#sink = options.sink
    this.#active = options.active
    this.#startedAt = options.startedAt
    this.#now = options.now
    this.#attributes = attributesMap(options.start.attributes)
  }

  public writeStart(): void {
    this.#write('debug', 'running', 0)
  }

  public setAttributes(...attributes: readonly TraceAttribute[]): void {
    for (const attribute of attributes) {
      const key = attribute.key.trim()
      if (key !== '') this.#attributes.set(key, attribute.value)
    }
  }

  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return this.#active.run(this.#state, operation)
  }

  public end(error?: Error): void {
    if (this.#ended) return
    this.#ended = true
    this.#write(
      error === undefined ? 'info' : 'error',
      error === undefined ? 'ok' : 'error',
      this.#now() - this.#startedAt,
      error
    )
  }

  #write(
    level: StructuredLogLevel,
    status: string,
    durationMilliseconds: number,
    error?: Error
  ): void {
    const fields: Record<string, StructuredLogValue> = {
      trace_id: this.#state.traceId,
      span_id: this.#state.spanId,
      'span.name': this.#name,
      status,
    }
    if (this.#parentSpanId !== '') fields['parent_span_id'] = this.#parentSpanId
    if (durationMilliseconds > 0) fields['duration_ms'] = durationMilliseconds
    if (error !== undefined) fields['error'] = error.message
    for (const [key, value] of this.#attributes.entries()) fields[key] = value
    this.#sink.write({ level, message: level === 'debug' ? 'span.start' : 'span.end', fields })
  }
}

function attributesMap(attributes: readonly TraceAttribute[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const attribute of attributes) {
    const key = attribute.key.trim()
    if (key !== '') result.set(key, attribute.value)
  }
  return result
}

function attributeValue(attributes: readonly TraceAttribute[], key: string): string | undefined {
  return attributes.find((attribute): boolean => attribute.key === key)?.value || undefined
}

/**
 * 返回非零且符合 W3C 格式的 16 字节 trace ID。
 * @returns 32 位十六进制字符串；全零会被下游判为非法，因此生成时会重试到非零为止
 */
export function newTraceId(): string {
  return randomHexId(16)
}

/**
 * 返回非零的 8 字节 span ID（`traceparent` 的 span-id 段）。
 * @returns 16 位十六进制字符串；与 trace ID 同理，全零值不被接受
 */
export function newSpanId(): string {
  return randomHexId(8)
}

function randomHexId(byteLength: number): string {
  let identifier = randomBytes(byteLength).toString('hex')
  while (/^0+$/u.test(identifier)) identifier = randomBytes(byteLength).toString('hex')
  return identifier
}
