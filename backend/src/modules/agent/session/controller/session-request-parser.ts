import { sessionParamsSchema } from '@red-bean/api-contract'
import { validationError } from '../../../../shared/http/error-mapper.js'

/** 校验路径参数里的会话 ID；失败抛 400。 */
export function parseSessionId(value: unknown): string {
  const parsed = sessionParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('会话 ID 不能为空')
  return parsed.data.id
}

/** 解析分页查询：limit 缺省、非法或非正数退回 20，上限 100；游标缺省为空串，表示取首页。 */
export function parseSessionPagination(value: unknown): {
  readonly cursor: string
  readonly limit: number
} {
  const query = isRecord(value) ? value : {}
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : ''
  const parsedLimit = positiveInteger(query['limit'])
  return { cursor, limit: parsedLimit === undefined ? 20 : Math.min(parsedLimit, 100) }
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
