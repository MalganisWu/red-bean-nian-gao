import { API_ROUTES } from '@red-bean/api-contract'
import { apiCall } from './client'
import {
  decodeEmptyEnvelope,
  decodeEnvelopeData,
  isTokenResponse,
  isUser,
} from './response-validation'
import type {
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RefreshResponse,
  User,
} from '@/types/api'

/**
 * 统一成功信封 {code, data}：服务层解包后返回 data，公开返回类型不变
 *
 * @param req - 登录凭据（用户名 / 密码）；响应体先经 decodeEnvelopeData 运行时校验，形状不符即抛错而非返回不可信数据。
 * @returns 校验通过后解析出的令牌响应。
 */
export async function login(req: LoginRequest): Promise<LoginResponse> {
  return apiCall(API_ROUTES.LOGIN.path, { method: 'POST', body: JSON.stringify(req) }, (value) =>
    decodeEnvelopeData(value, isTokenResponse, 'login')
  )
}

/**
 * 注册新账户；只负责创建账户，不建立本地会话（自动登录由调用方决定）。
 *
 * @param req - 注册信息（用户名 / 密码）；响应中的用户对象经 isUser 校验后才作为可信 User 返回。
 * @returns 新建账户的用户信息。
 */
export async function register(req: RegisterRequest): Promise<User> {
  return apiCall(API_ROUTES.REGISTER.path, { method: 'POST', body: JSON.stringify(req) }, (value) =>
    decodeEnvelopeData(value, isUser, 'register')
  )
}

/**
 * 用过期的访问令牌换取新令牌；是否登出由调用方决定。
 *
 * @param token - 当前访问令牌，以 Bearer 头携带；响应经 isTokenResponse 校验后收窄为 RefreshResponse。
 * @returns 新的令牌响应。
 */
export async function refresh(token: string): Promise<RefreshResponse> {
  return apiCall(
    API_ROUTES.REFRESH.path,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    (value) => decodeEnvelopeData(value, isTokenResponse, 'refresh')
  )
}

/**
 * 登出并让服务端失效当前会话；本地认证状态的清理由调用方负责。
 */
export async function logout(): Promise<void> {
  await apiCall(API_ROUTES.LOGOUT.path, { method: 'POST' }, decodeEmptyEnvelope)
}
