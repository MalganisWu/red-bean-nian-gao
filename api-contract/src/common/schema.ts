/*
 * 契约包内部共用的形状判定与信封解包工具。
 *
 * 这些守卫只保证「结构像」，不保证「语义对」——它们同时被 zod schema 与 SSE 帧解析复用，
 * 因此刻意不引入任何业务概念。真正的业务取值校验留在各自的 schema 与消费方分支里。
 */
import type { ApiEnvelope } from './dto.js'

/** 形状守卫的通用签名；`value is TValue` 让调用点在判真之后自动收窄类型。 */
export type Guard<TValue> = (value: unknown) => value is TValue

/** 非 null 且非数组的对象判定；数组在这里一律不算「记录」。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字符串判定；不过滤空串——空串是否为有效值由各 schema 自己决定。 */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 有限数判定；`NaN` 与 `±Infinity` 都会被拒（它们无法在 JSON 里往返）。 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 布尔判定；不做真值转换，字符串 `'true'` 与数字 `1` 都不算。 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** 字符串或 null；与 `isOptional` 组合，用于「可空但不可缺省」的字段。 */
export function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

/** 把守卫放宽到 `undefined`；用于「可以缺省，但给了就必须合法」的字段。 */
export function isOptional<TValue>(
  value: unknown,
  guard: Guard<TValue>
): value is TValue | undefined {
  return value === undefined || guard(value)
}

/** 数组且每个元素都过守卫；空数组判定为真。 */
export function isArrayOf<TValue>(value: unknown, guard: Guard<TValue>): value is TValue[] {
  return Array.isArray(value) && value.every(guard)
}

/** 解信封并校验形状；不合法直接抛错，错误信息带上 `label` 以便定位是哪个接口。 */
export function decodeEnvelopeData<TValue>(
  value: unknown,
  guard: Guard<TValue>,
  label: string
): TValue {
  if (!isRecord(value) || !isNumber(value['code']) || !('data' in value) || !guard(value['data'])) {
    throw new Error(`服务器响应格式无效：${label}`)
  }
  return value['data']
}

/** 信封判定；与 `decodeEnvelopeData` 同判据，但失败时返回 `false` 而不抛错。 */
export function isEnvelope<TValue>(
  value: unknown,
  guard: Guard<TValue>
): value is ApiEnvelope<TValue> {
  return isRecord(value) && isNumber(value['code']) && 'data' in value && guard(value['data'])
}

/** 校验「成功但无数据」的响应信封：只要求 `code` 存在，不检查 `data`。 */
export function decodeEmptyEnvelope(value: unknown): void {
  if (!isRecord(value) || !isNumber(value['code'])) {
    throw new Error('服务器响应格式无效：empty response')
  }
}

/** 从响应信封里取出 token；结构不符时返回 `undefined` 而不抛错，由调用方决定如何提示。 */
export function decodeRefreshToken(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value['data'])) return undefined
  return isString(value['data']['token']) ? value['data']['token'] : undefined
}
