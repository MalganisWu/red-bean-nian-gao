import { API_ROUTES, buildPath } from '@red-bean/api-contract'
import { apiCall } from './client'
import type { PublicUser, User } from '@/types/api'
import { decodeEnvelopeData, isPublicUser, isUser, isUserList } from './response-validation'

/**
 * 统一成功信封 {code, data}：服务层解包后返回 data，公开返回类型不变
 *
 * @returns 当前登录用户的完整信息；响应经 isUser 校验后才返回，形状不符即抛错。
 */
export async function getMe(): Promise<User> {
  return apiCall(API_ROUTES.ME.path, {}, (value) =>
    decodeEnvelopeData(value, isUser, 'current user')
  )
}

/**
 * 更新当前用户的资料；只提交传入的字段，未给出的字段保持不变。
 *
 * @param data - 待更新的资料子集（display_name / avatar / email）；响应经 isUser 校验后收窄为 User。
 * @returns 更新后的完整用户信息。
 */
export async function updateMe(
  data: Partial<Pick<User, 'display_name' | 'avatar' | 'email'>>
): Promise<User> {
  return apiCall(
    API_ROUTES.ME_UPDATE.path,
    { method: 'PUT', body: JSON.stringify(data) },
    (value) => decodeEnvelopeData(value, isUser, 'updated user')
  )
}

/**
 * 按 id 读取其他用户的公开资料。
 *
 * @param id - 目标用户标识，经 buildPath 填入路由模板；响应经 isPublicUser 校验后收窄为 PublicUser。
 * @returns 该用户的公开信息（不含敏感字段）。
 */
export async function getUser(id: string): Promise<PublicUser> {
  return apiCall(buildPath(API_ROUTES.USER.path, { id }), {}, (value) =>
    decodeEnvelopeData(value, isPublicUser, 'user detail')
  )
}

/**
 * 分页列出用户；offset 与 limit 直接进查询串，缺省从 0 起取 20 条。
 *
 * @param offset - 起始偏移量，缺省 0。
 * @param limit - 单页条数，缺省 20；响应经 isUserList 校验后返回。
 * @returns 一页公开用户信息与总数。
 */
export async function listUsers(
  offset = 0,
  limit = 20
): Promise<{ users: PublicUser[]; total: number }> {
  return apiCall(`${API_ROUTES.USERS.path}?offset=${offset}&limit=${limit}`, {}, (value) =>
    decodeEnvelopeData(value, isUserList, 'user list')
  )
}
