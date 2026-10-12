import { useCallback } from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { useChatStore } from '@/stores/chat-store'
import { useTaskStore } from '@/stores/task-store'
import * as authApi from '@/services/api/auth'
import * as userApi from '@/services/api/user'
import type { LoginRequest, RegisterRequest, User } from '@/types/api'

interface AuthControls {
  login: (request: LoginRequest) => Promise<void>
  register: (request: RegisterRequest) => Promise<void>
  logout: () => Promise<void>
  fetchMe: () => Promise<void>
  isAuthenticated: boolean
  user: User | null
}

/** 登录并把令牌与用户信息写入 auth store。 */
async function loginAndSetAuth(
  req: LoginRequest,
  setAuth: (token: string, user: User) => void
): Promise<void> {
  const res = await authApi.login(req)
  // 先存 token，再获取用户信息（getMe 需要读取 store 中的 token）
  useAuthStore.getState().setToken(res.token)
  const me = await userApi.getMe()
  setAuth(res.token, me)
}

/** 注册成功后自动登录，并把令牌与用户信息写入 auth store。 */
async function registerAndSetAuth(
  req: RegisterRequest,
  setAuth: (token: string, user: User) => void
): Promise<void> {
  await authApi.register(req)
  // 注册成功后自动登录
  const loginRes = await authApi.login({ username: req.username, password: req.password })
  useAuthStore.getState().setToken(loginRes.token)
  const me = await userApi.getMe()
  setAuth(loginRes.token, me)
}

/** 登出并清空本地认证状态；无论服务端登出是否成功，本地状态都要清干净。 */
async function logoutAndClearAuth(clearAuth: () => void): Promise<void> {
  try {
    await authApi.logout()
  } finally {
    // 用户级会话、任务与已读状态不能泄漏到下一次登录。
    useChatStore.getState().reset()
    useTaskStore.getState().reset()
    clearAuth()
  }
}

/** 拉取当前用户并写入 auth store。 */
async function fetchCurrentUser(setUser: (user: User) => void): Promise<void> {
  const me = await userApi.getMe()
  setUser(me)
}

/** 认证动作集合：登录、注册与登出，并同步维护 auth store 中的令牌与用户信息。 */
export function useAuth(): AuthControls {
  const { setAuth, clearAuth, setUser, isAuthenticated, user } = useAuthStore()

  const login = useCallback((req: LoginRequest) => loginAndSetAuth(req, setAuth), [setAuth])

  const register = useCallback(
    (req: RegisterRequest) => registerAndSetAuth(req, setAuth),
    [setAuth]
  )

  const logout = useCallback(() => logoutAndClearAuth(clearAuth), [clearAuth])

  const fetchMe = useCallback(() => fetchCurrentUser(setUser), [setUser])

  return { login, register, logout, fetchMe, isAuthenticated, user }
}
