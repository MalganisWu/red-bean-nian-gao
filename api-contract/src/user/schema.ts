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

export const registerUserSchema: z.ZodType<RegisterUserDto> = z.object({
  username: z.string().min(3).max(50),
  email: z.email(),
  password: z.string().min(8),
  display_name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
})

export const loginSchema: z.ZodType<LoginDto> = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const updateSelfSchema: z.ZodType<UpdateSelfDto> = z.object({
  display_name: z.string().optional(),
  avatar: z.string().nullable().optional(),
  email: z.string().optional(),
})

export const userParamsSchema = z.object({ id: z.string().min(1) })

export function isPublicUser(value: unknown): value is PublicUserDto {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isString(value['username']) &&
    isString(value['display_name']) &&
    isOptional(value['avatar'], isString)
  )
}

export function isSelfUser(value: unknown): value is SelfUserDto {
  return isRecord(value) && isString(value['email']) && isPublicUser(value)
}

export function isToken(value: unknown): value is TokenDto {
  return isRecord(value) && isString(value['token'])
}

export function isUserList(value: unknown): value is UserListDto {
  return isRecord(value) && isArrayOf(value['users'], isPublicUser) && isNumber(value['total'])
}
