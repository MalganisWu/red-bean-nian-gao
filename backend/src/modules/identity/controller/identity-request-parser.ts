import {
  loginSchema,
  registerUserSchema,
  updateSelfSchema,
  userParamsSchema,
  type LoginDto,
  type RegisterUserDto,
  type UpdateSelfDto,
} from '@red-bean/api-contract'
import { validationError } from '../../../shared/http/error-mapper.js'

/** 校验注册体（用户名、密码、展示名等）；失败抛 400，zod 的字段级报错不外泄。 */
export function parseRegisterUserDto(value: unknown): RegisterUserDto {
  const parsed = registerUserSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/** 校验登录体的形状；凭据是否正确不在这里判断，交给认证服务。 */
export function parseLoginDto(value: unknown): LoginDto {
  const parsed = loginSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/** 校验「改自己资料」的请求体；能否确实只改到自己由鉴权层与用例层保证。 */
export function parseUpdateSelfDto(value: unknown): UpdateSelfDto {
  const parsed = updateSelfSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/** 校验路径参数里的用户 ID。 */
export function parseUserId(value: unknown): string {
  const parsed = userParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data.id
}

/** 解析分页查询：offset 缺省或非法退回 0；limit 缺省、非法、为 0 或超 100 一律退回 20。 */
export function parseUserPagination(value: unknown): {
  readonly offset: number
  readonly limit: number
} {
  const query = isRecord(value) ? value : {}
  const offset = nonNegativeInteger(query['offset'], 0)
  const requestedLimit = nonNegativeInteger(query['limit'], 20)
  return { offset, limit: requestedLimit <= 0 || requestedLimit > 100 ? 20 : requestedLimit }
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
