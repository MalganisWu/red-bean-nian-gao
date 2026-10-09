import type { ApiEnvelope } from './dto.js'

export type Guard<TValue> = (value: unknown) => value is TValue

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

export function isOptional<TValue>(
  value: unknown,
  guard: Guard<TValue>
): value is TValue | undefined {
  return value === undefined || guard(value)
}

export function isArrayOf<TValue>(value: unknown, guard: Guard<TValue>): value is TValue[] {
  return Array.isArray(value) && value.every(guard)
}

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

export function isEnvelope<TValue>(
  value: unknown,
  guard: Guard<TValue>
): value is ApiEnvelope<TValue> {
  return isRecord(value) && isNumber(value['code']) && 'data' in value && guard(value['data'])
}

export function decodeEmptyEnvelope(value: unknown): void {
  if (!isRecord(value) || !isNumber(value['code'])) {
    throw new Error('服务器响应格式无效：empty response')
  }
}

export function decodeRefreshToken(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value['data'])) return undefined
  return isString(value['data']['token']) ? value['data']['token'] : undefined
}
