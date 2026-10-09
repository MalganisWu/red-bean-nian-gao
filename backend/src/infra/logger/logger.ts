import { AsyncLocalStorage } from 'node:async_hooks'
import { optionalField } from '../../shared/object/optional-field.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Readonly<Record<string, unknown>>

export interface LogDestination {
  write(line: string): void
}

export interface LoggerOptions {
  readonly format: string
  readonly level: string
  readonly destination?: LogDestination
  readonly now?: () => Date
}

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

export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(options)
}

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
