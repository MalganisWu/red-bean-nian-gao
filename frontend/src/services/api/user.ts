import { API_ROUTES, buildPath } from '@red-bean/api-contract'
import { apiCall } from './client'
import type { PublicUser, User } from '@/types/api'
import { decodeEnvelopeData, isPublicUser, isUser, isUserList } from './response-validation'

/** 统一成功信封 {code, data}：服务层解包后返回 data，公开返回类型不变 */
export async function getMe(): Promise<User> {
  return apiCall(API_ROUTES.ME.path, {}, (value) =>
    decodeEnvelopeData(value, isUser, 'current user')
  )
}

export async function updateMe(
  data: Partial<Pick<User, 'display_name' | 'avatar' | 'email'>>
): Promise<User> {
  return apiCall(
    API_ROUTES.ME_UPDATE.path,
    { method: 'PUT', body: JSON.stringify(data) },
    (value) => decodeEnvelopeData(value, isUser, 'updated user')
  )
}

export async function getUser(id: string): Promise<PublicUser> {
  return apiCall(buildPath(API_ROUTES.USER.path, { id }), {}, (value) =>
    decodeEnvelopeData(value, isPublicUser, 'user detail')
  )
}

export async function listUsers(
  offset = 0,
  limit = 20
): Promise<{ users: PublicUser[]; total: number }> {
  return apiCall(`${API_ROUTES.USERS.path}?offset=${offset}&limit=${limit}`, {}, (value) =>
    decodeEnvelopeData(value, isUserList, 'user list')
  )
}
