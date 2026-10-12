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

  public current(): Logger {
    return this.#storage.getStore() ?? this.#defaultLogger
  }

  public run<TValue>(logger: Logger, operation: () => TValue): TValue {
    return this.#storage.run(logger, operation)
  }

  public setDefault(logger: Logger): void {
    this.#defaultLogger = logger
  }
}

/** 造一个根 logger；请求级字段一律经 `child` 派生，避免并发请求互相污染。 */
export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(options)
}

/**
 * 解析日志级别，无法识别时退回 `info`。
 * 刻意不抛错：一个拼错的 LOG_LEVEL 不该让服务起不来；但也不能悄悄变成 `debug`
 * （那会在生产环境刷出大量日志），所以收口到中间的 `info`。
 * 顺带接受 `warning` 这个常见别名。
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
