import type {
  LoginDto,
  PublicUserDto,
  RegisterUserDto,
  SelfUserDto,
  TokenDto,
  UpdateSelfDto,
  UserListDto,
} from './dto.js'
import { z } from 'zod'
import { isArrayOf, isNumber, isOptional, isRecord, isString } from '../common/schema.js'

/** 注册请求校验：用户名 3–50、密码至少 8 位、邮箱需合法；`avatar` 可空可缺省。 */
export const registerUserSchema: z.ZodType<RegisterUserDto> = z.object({
  username: z.string().min(3).max(50),
  email: z.email(),
  password: z.string().min(8),
  display_name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
})

/** 登录请求校验；只校验「非空」，凭据对不对由认证服务判断。 */
export const loginSchema: z.ZodType<LoginDto> = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

/** 更新自己资料的校验；三个字段全可选，空对象合法（等价于不改任何东西）。 */
export const updateSelfSchema: z.ZodType<UpdateSelfDto> = z.object({
  display_name: z.string().optional(),
  avatar: z.string().nullable().optional(),
  email: z.string().optional(),
})

/** 用户 ID 的路径参数校验。 */
export const userParamsSchema = z.object({ id: z.string().min(1) })

/**
 * 公开用户信息的守卫；不含邮箱，`avatar` 可选。
 * @param value - 待判定的用户对象；`id` / `username` / `display_name` 必需，`avatar` 可选。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isPublicUser(value: unknown): value is PublicUserDto {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isString(value['username']) &&
    isString(value['display_name']) &&
    isOptional(value['avatar'], isString)
  )
}

/**
 * 自己的用户信息守卫：在公开字段之上额外要求 `email`。
 * @param value - 待判定的用户对象；公开字段合法之外还必须有字符串 `email`。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isSelfUser(value: unknown): value is SelfUserDto {
  return isRecord(value) && isString(value['email']) && isPublicUser(value)
}

/**
 * 令牌响应的守卫；只有 `token` 一个字段。
 * @param value - 待判定的令牌响应；`token` 必须是字符串。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isToken(value: unknown): value is TokenDto {
  return isRecord(value) && isString(value['token'])
}

/**
 * 用户列表的守卫；逐项过 `isPublicUser`。
 * @param value - 待判定的列表响应；`users` 每项合法且 `total` 为数字。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isUserList(value: unknown): value is UserListDto {
  return isRecord(value) && isArrayOf(value['users'], isPublicUser) && isNumber(value['total'])
}
