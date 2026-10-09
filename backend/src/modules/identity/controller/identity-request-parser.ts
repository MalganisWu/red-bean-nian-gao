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

export function parseRegisterUserDto(value: unknown): RegisterUserDto {
  const parsed = registerUserSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

export function parseLoginDto(value: unknown): LoginDto {
  const parsed = loginSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

export function parseUpdateSelfDto(value: unknown): UpdateSelfDto {
  const parsed = updateSelfSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

export function parseUserId(value: unknown): string {
  const parsed = userParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data.id
}

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
