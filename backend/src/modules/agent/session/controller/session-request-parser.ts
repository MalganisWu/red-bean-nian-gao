import { sessionParamsSchema } from '@red-bean/api-contract'
import { validationError } from '../../../../shared/http/error-mapper.js'

/**
 * 校验路径参数里的会话 ID；失败抛 400。
 *
 * @param value - 路由解包出的原始路径参数，形状与内容都不可信，一律经 Schema 校验。
 * @returns 通过校验的会话 ID 字符串。
 */
export function parseSessionId(value: unknown): string {
  const parsed = sessionParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('会话 ID 不能为空')
  return parsed.data.id
}

/**
 * 解析分页查询：limit 缺省、非法或非正数退回 20，上限 100；游标缺省为空串，表示取首页。
 *
 * @param value - 路由解包出的原始 query，可能不是对象，非对象一律按空查询处理而非报错。
 * @returns 规范化后的游标与页大小，二者都不可能是非法值。
 */
export function parseSessionPagination(value: unknown): {
  readonly cursor: string
  readonly limit: number
} {
  const query = isRecord(value) ? value : {}
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : ''
  const parsedLimit = positiveInteger(query['limit'])
  return { cursor, limit: parsedLimit === undefined ? 20 : Math.min(parsedLimit, 100) }
}

/**
 * 把 query 里的数字字符串解析为正整数，不可用时返回 `undefined` 交由调用方决定默认值。
 *
 * 只接受纯十进制整数串：直接交给 `Number` 会把 `'1e3'`、`'0x10'`、`' 1 '` 也解析成数字，
 * 让页大小出现预期外的取值；超出安全整数或不算正数的同样拒绝，宁可回落默认值也不放大请求。
 *
 * @param value - 未经校验的 query 字段值
 * @returns 解析出的正整数；非字符串、非纯数字、非安全整数或不为正时返回 `undefined`
 */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 判断解包出的 query 是否为可索引的记录，排除 `null` 与数组。
 *
 * query 由 Fastify 直接解包，形状不可信；这里不做严格校验而只做形状窄化，是因为分页参数
 * 另有逐字段兜底，非对象时按空查询处理即可，不必为此返回 400。
 *
 * @param value - 未经校验的 query 输入
 * @returns 是否为非 null、非数组的记录
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
