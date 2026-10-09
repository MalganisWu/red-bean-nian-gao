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

/** 统一成功信封 {code, data}：服务层解包后返回 data，公开返回类型不变 */
export async function login(req: LoginRequest): Promise<LoginResponse> {
  return apiCall(API_ROUTES.LOGIN.path, { method: 'POST', body: JSON.stringify(req) }, (value) =>
    decodeEnvelopeData(value, isTokenResponse, 'login')
  )
}

export async function register(req: RegisterRequest): Promise<User> {
  return apiCall(API_ROUTES.REGISTER.path, { method: 'POST', body: JSON.stringify(req) }, (value) =>
    decodeEnvelopeData(value, isUser, 'register')
  )
}

export async function refresh(token: string): Promise<RefreshResponse> {
  return apiCall(
    API_ROUTES.REFRESH.path,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    (value) => decodeEnvelopeData(value, isTokenResponse, 'refresh')
  )
}

export async function logout(): Promise<void> {
  await apiCall(API_ROUTES.LOGOUT.path, { method: 'POST' }, decodeEmptyEnvelope)
}
