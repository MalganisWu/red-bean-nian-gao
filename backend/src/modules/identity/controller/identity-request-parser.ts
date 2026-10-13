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

/**
 * 校验注册体（用户名、密码、展示名等）；失败抛 400，zod 的字段级报错不外泄。
 *
 * @param value - 未经信任的请求体原始值（来自 `request.body`）；必须先过 Schema 才可当 DTO 用
 * @returns `registerUserSchema` 的解析结果，缺失字段已按 Schema 补默认、类型已收窄
 */
export function parseRegisterUserDto(value: unknown): RegisterUserDto {
  const parsed = registerUserSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/**
 * 校验登录体的形状；凭据是否正确不在这里判断，交给认证服务。
 *
 * @param value - 未经信任的登录体原始值；只校验形状，账号密码是否匹配由认证服务判定
 * @returns `loginSchema` 的解析结果，形状合法但内容未必正确
 */
export function parseLoginDto(value: unknown): LoginDto {
  const parsed = loginSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/**
 * 校验「改自己资料」的请求体；能否确实只改到自己由鉴权层与用例层保证。
 *
 * @param value - 未经信任的请求体原始值；不承载「改的是谁」，目标用户由鉴权结果另行注入
 * @returns `updateSelfSchema` 的解析结果，未提供的字段保持缺省以便用例层区分「不改」与「置空」
 */
export function parseUpdateSelfDto(value: unknown): UpdateSelfDto {
  const parsed = updateSelfSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/**
 * 校验路径参数里的用户 ID。
 *
 * @param value - 未经信任的路径参数对象（来自 `request.params`）；id 必须是合法 uuid，否则抛 400
 * @returns 已确认形状合法的用户 ID 字符串
 */
export function parseUserId(value: unknown): string {
  const parsed = userParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data.id
}

/**
 * 解析分页查询：offset 缺省或非法退回 0；limit 缺省、非法、为 0 或超 100 一律退回 20。
 *
 * 查询串里的值一律是字符串，且分页是**非关键参数**：这里刻意不抛错而是静默回退到安全默认，
 * 避免一个手改的 `?limit=abc` 让整个列表接口 400。
 *
 * @param value - 未经信任的查询串对象（来自 `request.query`）；非对象、缺字段或非法值都走回退
 * @returns 归一化后的 `offset`/`limit`，两者都是非负整数且 `limit` 已夹在 1..100
 */
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
