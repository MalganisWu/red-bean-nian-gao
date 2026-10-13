import { Cron } from 'croner'

import { contextualError } from './../error/contextual-error.js'

/**
 * 解析 run_at：接受 RFC3339，也接受无偏移的 `YYYY-MM-DD HH:mm:ss`（后者按给定时区解释，不是 UTC）。
 *
 * @param value - 待解析的时间字符串；两种格式都不匹配时抛错。
 * @param timezone - 解释无偏移时间所用的 IANA 时区名。
 * @returns 解析出的绝对时刻；无偏移格式会按 `timezone` 归一到 UTC。
 */
export function parseRunAt(value: string, timezone: string): Date {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.valueOf())) return parsed
  }
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value)
  if (match !== null) {
    const parts = match.slice(1).map(Number)
    const [year, month, day, hour, minute, second] = parts
    if (
      year !== undefined &&
      month !== undefined &&
      day !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      second !== undefined
    ) {
      const parsed = zonedDate(year, month, day, hour, minute, second, timezone)
      if (parsed !== undefined) return parsed
    }
  }
  throw new Error(
    `run_at 格式无法解析：接受 RFC3339 或 "2006-01-02 15:04:05"（无偏移按 ${timezone} 解释）`
  )
}

/**
 * 算下一个 cron 触发时刻；只接受 5 字段表达式，带秒/年字段的会被 `croner` 拒掉并转成中文提示。
 *
 * @param expression - 5 字段 cron（分 时 日 月 周）；非法表达式抛错。
 * @param timezone - 解释 cron 所用的 IANA 时区名。
 * @param now - 计算基准时刻，返回严格晚于它的下一次触发时间。
 * @returns 下一次触发时刻。
 */
export function nextRecurring(expression: string, timezone: string, now: Date): Date {
  try {
    const cron = new Cron(expression, { timezone, paused: true, mode: '5-part' })
    const next = cron.nextRun(now)
    if (next === null) throw new Error('cron 没有下一次执行时间')
    return next
  } catch (cause: unknown) {
    throw contextualError(
      'cron 表达式无效：需 5 字段（分 时 日 月 周）如 "0 9 * * *"，不支持秒/年字段',
      cause
    )
  }
}

/**
 * 用 `Intl` 试构造一次来校验时区名；不维护清单，因此永远与运行时的 tzdata 一致。
 *
 * @param timezone - 待校验的 IANA 时区名；无效时抛错。
 */
export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
  } catch (cause: unknown) {
    throw contextualError(`时区 ${JSON.stringify(timezone)} 无效`, cause)
  }
}

/**
 * 把「给定时区下的年月日时分秒」换算成绝对时刻，并校验该本地时间真实存在。
 * 先按 UTC 猜一个时刻，再按 guess 的时间差迭代修正；夏令时切换造成的空档或重复时间
 * 会使修正后仍对不上本地字段，此时返回 undefined 交由调用方判为非法输入。
 *
 * @param year - 本地年份。
 * @param month - 本地月份（1-12）。
 * @param day - 本地日。
 * @param hour - 本地小时（0-23）。
 * @param minute - 本地分钟。
 * @param second - 本地秒。
 * @param timezone - 解释该本地时间所用的 IANA 时区名。
 * @returns 对应的绝对时刻；本地时间不存在（如夏令时空档）时为 undefined。
 */
function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string
): Date | undefined {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)
  const calendar = new Date(utcGuess)
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return undefined
  }
  let candidate = new Date(utcGuess)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(candidate, timezone)
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    )
    const difference = utcGuess - actualAsUtc
    if (difference === 0) break
    candidate = new Date(candidate.valueOf() + difference)
  }
  const result = zonedParts(candidate, timezone)
  return result.year === year &&
    result.month === month &&
    result.day === day &&
    result.hour === hour &&
    result.minute === minute &&
    result.second === second
    ? candidate
    : undefined
}

/** 某个绝对时刻在指定时区下展开出的本地日历字段。 */
interface ZonedParts {
  /** 本地年份。 */
  readonly year: number
  /** 本地月份（1-12，非 JS 的 0 基）。 */
  readonly month: number
  /** 本地日。 */
  readonly day: number
  /** 本地小时（0-23，按 h23 取值避免 12/24 歧义）。 */
  readonly hour: number
  /** 本地分钟。 */
  readonly minute: number
  /** 本地秒。 */
  readonly second: number
}

/**
 * 用 `Intl` 把绝对时刻展开成给定时区下的本地日历字段，供换算迭代与存在性校验使用。
 *
 * @param date - 待展开的绝对时刻。
 * @param timezone - 目标 IANA 时区名。
 * @returns 该时刻在该时区下的本地年月日时分秒。
 */
function zonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part): boolean => part.type !== 'literal')
      .map((part): readonly [string, string] => [part.type, part.value])
  )
  return {
    year: requiredDatePart(values, 'year'),
    month: requiredDatePart(values, 'month'),
    day: requiredDatePart(values, 'day'),
    hour: requiredDatePart(values, 'hour'),
    minute: requiredDatePart(values, 'minute'),
    second: requiredDatePart(values, 'second'),
  }
}

/**
 * 从格式化结果里取出一个必需的日期部分并转成数字；缺失即抛错，
 * 因为格式化器缺字段说明运行环境异常，继续下去只会得到错位的时间。
 *
 * @param values - `formatToParts` 抽出的字段映射。
 * @param name - 字段名，如 year/month/day/hour/minute/second。
 * @returns 该字段的数值。
 */
function requiredDatePart(values: ReadonlyMap<string, string>, name: string): number {
  const value = values.get(name)
  if (value === undefined) throw new Error(`时区格式缺少 ${name}`)
  return Number(value)
}
