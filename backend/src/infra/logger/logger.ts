import { AsyncLocalStorage } from 'node:async_hooks'
import { optionalField } from '../../shared/object/optional-field.js'

/** 日志级别；权重见 `LEVEL_WEIGHT`，低于下限的调用在 `#emit` 里被直接丢掉。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
/** 结构化字段；值不限制类型，Error 等不可枚举对象由 `errorJsonReplacer` 负责展开。 */
export type LogFields = Readonly<Record<string, unknown>>

/** 输出目标；抽成接口是为了让测试断言写出的行，而不必去抓 stdout。 */
export interface LogDestination {
  write(line: string): void
}

/** 构造选项；`destination` 与 `now` 可注入，测试因此不依赖真实时钟与终端。 */
export interface LoggerOptions {
  readonly format: string
  readonly level: string
  readonly destination?: LogDestination
  readonly now?: () => Date
}

/** 应用内统一的日志入口；请求级字段用 `child` 派生，不要共享实例就地改状态。 */
export interface Logger {
  child(fields: LogFields): Logger
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
})

const stdoutDestination: LogDestination = {
  write(line: string): void {
    process.stdout.write(`${line}\n`)
  },
}

/**
 * 结构化日志实现。两种输出格式对应两种消费方：
 * - `json`：一行一个 JSON 对象，给日志采集器解析。
 * - `text`（默认）：`key=value` 便于人读，本地开发与直接看容器输出时用它。
 *
 * `child` 不修改原实例而是派生新实例，绑定的字段只向下继承。
 * 请求级的字段（trace_id 等）因此不会泄漏到兄弟请求——这也是为什么字段走不可变继承，
 * 而不是往一个共享对象上 set。
 */
class StructuredLogger implements Logger {
  readonly #format: 'json' | 'text'
  readonly #minimumLevel: LogLevel
  readonly #destination: LogDestination
  readonly #now: () => Date
  readonly #fields: LogFields

  public constructor(options: LoggerOptions, fields: LogFields = {}) {
    this.#format = options.format.trim().toLowerCase() === 'json' ? 'json' : 'text'
    this.#minimumLevel = parseLogLevel(options.level)
    this.#destination = options.destination ?? stdoutDestination
    this.#now = options.now ?? ((): Date => new Date())
    this.#fields = fields
  }

  public child(fields: LogFields): Logger {
    return new StructuredLogger(
      {
        format: this.#format,
        level: this.#minimumLevel,
        destination: this.#destination,
        now: this.#now,
      },
      { ...this.#fields, ...fields }
    )
  }

  public debug(message: string, fields: LogFields = {}): void {
    this.#emit('debug', message, fields)
  }

  public info(message: string, fields: LogFields = {}): void {
    this.#emit('info', message, fields)
  }

  public warn(message: string, fields: LogFields = {}): void {
    this.#emit('warn', message, fields)
  }

  public error(message: string, fields: LogFields = {}): void {
    this.#emit('error', message, fields)
  }

  #emit(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.#minimumLevel]) return
    const record: LogFields = {
      ...this.#fields,
      ...fields,
      time: this.#now().toISOString(),
      level: level.toUpperCase(),
      msg: message,
    }
    this.#destination.write(
      this.#format === 'json' ? JSON.stringify(record, errorJsonReplacer) : formatTextRecord(record)
    )
  }
}

/** 显式传递请求级 logger；每个应用实例独立持有。 */
export class LoggerContext {
  readonly #storage = new AsyncLocalStorage<Logger>()
  #defaultLogger: Logger

  public constructor(defaultLogger: Logger) {
    this.#defaultLogger = defaultLogger
  }

  /**
   * 取出当前执行上下文绑定的 logger。
   * 绑定只在 `run` 的回调期间存在：进入回调时绑定、回调返回（同步返回或 Promise 落定）
   * 后自动解绑；在这之外调用拿到的是默认 logger，因此后台任务与测试不会意外继承
   * 某个请求的字段。
   * @returns 当前上下文的 logger；未处于任何 `run` 上下文时为默认 logger
   */
  public current(): Logger {
    return this.#storage.getStore() ?? this.#defaultLogger
  }

  /**
   * 在指定 logger 的上下文中执行回调，绑定随回调的作用域自动生效与失效。
   * 绑定是异步安全的：回调内部（含 await 之后恢复的部分）派生的异步任务继续看到同一个
   * logger，而并发执行的其他上下文互不可见——这正是请求级字段不串号的原因。
   * 嵌套调用时内层 logger 覆盖外层，回调结束即恢复外层。
   * @param logger - 该上下文内 `current()` 返回的实例
   * @param operation - 回调；其返回值与同步抛出都原样透传，不做包装
   * @returns 回调的返回值
   */
  public run<TValue>(logger: Logger, operation: () => TValue): TValue {
    return this.#storage.run(logger, operation)
  }

  /**
   * 替换上下文之外的兜底 logger，通常在组装期把根 logger 换成带进程级字段的版本。
   * 它不影响任何已经开始的 `run` 上下文，只决定此后 `current()` 在无绑定时的返回值。
   * @param logger - 新的默认 logger，覆盖构造时传入的那个
   */
  public setDefault(logger: Logger): void {
    this.#defaultLogger = logger
  }
}

/**
 * 造一个根 logger；请求级字段一律经 `child` 派生，避免并发请求互相污染。
 * @param options - 构造选项；`format` 非 `json` 一律按 `text` 处理，`level` 无法识别时退回 `info`
 * @returns 已按选项定级的 logger；它自身不带任何字段，字段靠 `child` 逐层叠加
 */
export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(options)
}

/**
 * 解析日志级别，无法识别时退回 `info`。
 * 刻意不抛错：一个拼错的 LOG_LEVEL 不该让服务起不来；但也不能悄悄变成 `debug`
 * （那会在生产环境刷出大量日志），所以收口到中间的 `info`。
 * 顺带接受 `warning` 这个常见别名。
 * @param value - 配置或环境变量里的级别文本，大小写与前后空白都会归一化
 * @returns 归一化后的级别；任何无法识别的输入都收敛为 `info`，绝不抛错
 */
export function parseLogLevel(value: string): LogLevel {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'debug') return 'debug'
  if (normalized === 'warn' || normalized === 'warning') return 'warn'
  if (normalized === 'error') return 'error'
  return 'info'
}

function formatTextRecord(record: LogFields): string {
  return Object.entries(record)
    .map(([key, value]): string => `${key}=${formatTextValue(value)}`)
    .join(' ')
}

/**
 * 文本格式下的取值：含空白或 `=` 的字符串必须加引号。
 * 不加的话 `msg=hello world user=alice` 就没法区分边界，靠肉眼解析这类日志很容易读错。
 */
function formatTextValue(value: unknown): string {
  if (typeof value === 'string') return /[\s=]/u.test(value) ? JSON.stringify(value) : value
  // 文本格式中的结构值同样可能嵌套 Error；复用 JSON replacer，避免 cause/errors 退化为 `{}`。
  const serialized = JSON.stringify(value, errorJsonReplacer)
  return serialized ?? String(value)
}

/** Error 的关键字段默认不可枚举，必须显式投影后才能进入结构化日志。 */
function errorJsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value
}

function serializeError(error: Error): Readonly<Record<string, unknown>> {
  return {
    name: error.name,
    message: error.message,
    ...optionalField('stack', error.stack),
    ...optionalField('cause', error.cause),
    ...(error instanceof AggregateError ? { errors: error.errors } : {}),
  }
}
