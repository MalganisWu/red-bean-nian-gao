import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

import type { TraceAttribute, TraceSpan, TracerPort } from '../../shared/observability/tracer.js'

/** 只有三档：span 开始固定记 debug，结束按成败记 info / error。 */
export type StructuredLogLevel = 'debug' | 'info' | 'error'
/** 字段值限标量：采集器要能直接索引，嵌套结构会退化成不可查询的字符串。 */
export type StructuredLogValue = string | number

/** 一条 span 日志；字段平铺，键名即索引键（`trace_id`、`span.name` 等）。 */
export interface StructuredLogRecord {
  /** 日志级别；采集端据此分流，不参与字段索引。 */
  readonly level: StructuredLogLevel
  /** 人读的事件名，取 `span.start` / `span.end` 这类短标识，不做本地化。 */
  readonly message: string
  /** 平铺的字段集合；键名即索引键，值限标量以免退化成不可查询的字符串。 */
  readonly fields: Readonly<Record<string, StructuredLogValue>>
}

/** 输出目标；默认实现往 stdout 写一行 JSON。 */
export interface StructuredLogSink {
  /**
   * 落一条日志记录。
   * 实现应当同步返回且不向上抛错：观测是旁路，写失败只该丢掉观测数据，
   * 绝不能中断被观测的业务流程。
   * @param record - 待落库的记录；字段已在此前拼装并标量化
   */
  write(record: StructuredLogRecord): void
}

/** 构造选项；全部可注入，测试因此能在不碰 stdout、不依赖真实随机源的前提下断言 span。 */
export interface StructuredLogTracerOptions {
  /** 日志落点；缺省写 stdout 一行 JSON，交给容器日志采集器索引。 */
  readonly sink?: StructuredLogSink | undefined
  /**
   * trace ID 生成器；缺省用密码学随机源，注入后测试可断言固定链路。
   * @returns 新链路的 trace ID；须为非零的 32 位十六进制串
   */
  readonly traceIdGenerator?: (() => string) | undefined
  /**
   * span ID 生成器；缺省同样用随机源，注入理由与 trace ID 一致。
   * @returns 新 span 的 ID；须为非零的 16 位十六进制串
   */
  readonly spanIdGenerator?: (() => string) | undefined
  /**
   * 结束时刻的取值来源；缺省为 `Date.now`，注入后测试可断言确定的耗时字段。
   * @returns 当前时刻，epoch 毫秒
   */
  readonly now?: (() => number) | undefined
}

/** 绑定在异步上下文里的当前 span 标识；子 span 据此沿用父链路的 trace ID。 */
interface ActiveStructuredLogSpan {
  /** 所属链路的 trace ID；同一请求内所有 span 共享同一个值。 */
  readonly traceId: string
  /** 本 span 自身的 ID；其下游子 span 会另生成新值，不沿用本值作为自身 ID。 */
  readonly spanId: string
}

/** 默认落点：把每条记录序列化成一行 JSON 写 stdout，交给容器日志采集器索引。 */
class JsonConsoleLogSink implements StructuredLogSink {
  /**
   * 把记录写成一行 JSON 追加到 stdout。
   * 结尾的换行符是刻意保留的：采集器按行切分，缺了它会丢掉记录边界。
   * @param record - 待落库的记录；字段已平铺，直接序列化即可
   */
  public write(record: StructuredLogRecord): void {
    process.stdout.write(`${JSON.stringify(record)}\n`)
  }
}

/** Runtime tracing 契约的零依赖结构化日志实现。 */
export class StructuredLogTracer implements TracerPort {
  /** 保存当前活跃 span 的异步上下文存储；`within` 在此进入，退出即恢复上一层。 */
  readonly #active = new AsyncLocalStorage<ActiveStructuredLogSpan>()
  /** 记录落点；构造时注入，缺省退回 stdout 实现。 */
  readonly #sink: StructuredLogSink
  /**
   * 新链路的 trace ID 来源；缺省用随机源。
   * @returns 新链路的 trace ID；须符合 W3C 非零格式
   */
  readonly #traceIdGenerator: () => string
  /**
   * 新 span 的 ID 来源；缺省用随机源。
   * @returns 新 span 的 ID；须符合 W3C 非零格式
   */
  readonly #spanIdGenerator: () => string
  /**
   * 耗时计算用的时钟；缺省为 `Date.now`。
   * @returns 当前时刻，epoch 毫秒
   */
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

/** 组装一条 span 所需的全部依赖；由 `StructuredLogTracer.start` 一次性传入。 */
interface StructuredLogSpanOptions {
  /** 建 span 时的入参：名字与初始属性，后者参与父级 trace ID 的解析。 */
  readonly start: { readonly name: string; readonly attributes: readonly TraceAttribute[] }
  /** 本 span 的标识快照；`within` 绑进异步上下文的正是它。 */
  readonly state: ActiveStructuredLogSpan
  /** 远端父 span 的 ID；无远端父时为空串，空串不会被写进日志字段。 */
  readonly parentSpanId: string
  /** 记录落点，与 tracer 共用同一个 sink。 */
  readonly sink: StructuredLogSink
  /** 活跃 span 的异步上下文存储；`within` 在此切换与恢复。 */
  readonly active: AsyncLocalStorage<ActiveStructuredLogSpan>
  /** span 起始时刻（毫秒）；结束事件据它算出耗时。 */
  readonly startedAt: number
  /**
   * 结束时刻的取值来源；与起始时刻同一时钟，避免跨时钟漂移。
   * @returns 当前时刻，epoch 毫秒
   */
  readonly now: () => number
}

/**
 * 单条 span 的句柄，也是状态绑定的入口。
 * `start` 建出它并立刻记下开始事件；只有 `within` 会把它设为活跃 span，`end` 写完
 * 结束事件把它收尾。`end` 幂等，重复调用只生效一次。
 */
class StructuredLogSpan implements TraceSpan {
  /** span 名；写进 `span.name` 字段，采集端据此聚合。 */
  readonly #name: string
  /** 本 span 的标识快照；`within` 绑定的对象。 */
  readonly #state: ActiveStructuredLogSpan
  /** 远端父 span 的 ID；空串表示无远端父，不落字段。 */
  readonly #parentSpanId: string
  /** 记录落点。 */
  readonly #sink: StructuredLogSink
  /** 活跃 span 的异步上下文存储。 */
  readonly #active: AsyncLocalStorage<ActiveStructuredLogSpan>
  /** span 起始时刻（毫秒）。 */
  readonly #startedAt: number
  /**
   * 结束时刻的取值来源；与起始时刻同一时钟。
   * @returns 当前时刻，epoch 毫秒
   */
  readonly #now: () => number
  /** 属性表；初始属性来自 start，`setAttributes` 可就地补充或覆盖。 */
  readonly #attributes: Map<string, string>
  /** 是否已写过结束事件；置位后 `end` 不再重复写。 */
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

  /**
   * 写出开始事件：固定 `debug` 级、`running` 状态、零耗时。
   * 由 `start` 在返回句柄前调用一次；单独再调会多写一条开始日志，且不改变 `#ended`。
   */
  public writeStart(): void {
    this.#write('debug', 'running', 0)
  }

  /**
   * 补充或覆盖本 span 的属性。
   * 覆盖语义是刻意的：后写的属性应当能修正先前的取值。空键被忽略，
   * 因此空白键不会以空名字混进字段集合。
   * @param attributes - 待并入的属性；同名键以本次为准，空键跳过
   */
  public setAttributes(...attributes: readonly TraceAttribute[]): void {
    for (const attribute of attributes) {
      const key = attribute.key.trim()
      if (key !== '') this.#attributes.set(key, attribute.value)
    }
  }

  /**
   * 在「本 span 为活跃 span」的异步上下文中执行操作。
   * 绑定只在回调及其派生的异步调用内可见；回调返回（无论成败）后上下文自动恢复为外层
   * span，因此并发请求不会串链。本方法不做结尾：成功与失败都由调用方再调 `end` 收尾，
   * 它是「进」`within`、「出」`end` 这对生命周期的一半。
   * @param operation - 需要绑定本 span 上下文的异步操作
   * @returns 与 `operation` 同值的 Promise；其兑现或拒绝原样透传，不在此改写
   */
  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return this.#active.run(this.#state, operation)
  }

  /**
   * 结束 span 并写出结束事件；幂等，重复调用只生效一次。
   * 成败决定级别与状态：无错误记 `info` / `ok`，传入错误记 `error` / `error`，
   * 并把错误消息并入 `error` 字段 —— 失败路径同样要留下可检索的记录。
   * @param error - 令本次 span 失败的错误；不传表示正常结束
   */
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

  /**
   * 拼装字段并交给 sink，是开始与结束事件共用的唯一出口。
   * 字段按需添加：无远端父不写 `parent_span_id`，耗时为零不写 `duration_ms`
   * （零耗时多来自未真正经过时钟的测试替身），无错误不写 `error`。
   * @param level - 日志级别；开始固定 debug，结束按成败取 info / error
   * @param status - 状态字段；取 running / ok / error
   * @param durationMilliseconds - 从开始到本次写入的毫秒数；开始事件传 0
   * @param error - 令本次 span 失败的错误；仅结束事件在失败时传入
   */
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

/**
 * 把属性数组转成可变更的键值表，供 span 中途读写。
 * 空键在此与 `setAttributes` 一致地被丢弃；同名键后者胜出。
 * @param attributes - 待转换的属性数组；顺序决定同名键的最终取值
 * @returns 键为去空白后的属性键、值为属性值的映射
 */
function attributesMap(attributes: readonly TraceAttribute[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const attribute of attributes) {
    const key = attribute.key.trim()
    if (key !== '') result.set(key, attribute.value)
  }
  return result
}

/**
 * 按 key 取属性值，命中空串时按「没有」处理。
 * 返回 `undefined` 而不是空串，是为了让调用方的 `??` 回退链能继续走到下一个候选来源。
 * @param attributes - 待查找的属性数组
 * @param key - 目标属性键；要求完全相等，不做大小写折叠
 * @returns 首个匹配属性的值；未命中或值为空串时为 `undefined`
 */
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

/**
 * 生成指定位数的随机十六进制标识。
 * 全零值会被 W3C 校验判为非法，故拒绝全零并重抽；循环必然终止，因为非零结果的
 * 概率为 1 减去可忽略的极小值。
 * @param byteLength - 随机字节数；返回串的十六进制长度为它的两倍
 * @returns 十六进制字符串；保证不全为零
 */
function randomHexId(byteLength: number): string {
  let identifier = randomBytes(byteLength).toString('hex')
  while (/^0+$/u.test(identifier)) identifier = randomBytes(byteLength).toString('hex')
  return identifier
}
