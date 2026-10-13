import { useCallback } from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { useChatStore } from '@/stores/chat-store'
import { useTaskStore } from '@/stores/task-store'
import * as authApi from '@/services/api/auth'
import * as userApi from '@/services/api/user'
import type { LoginRequest, RegisterRequest, User } from '@/types/api'

/** useAuth 的返回契约：登录、注册、登出、拉取当前用户四个动作，以及当前认证态快照。 */
interface AuthControls {
  /**
   * 登录：成功后写入令牌与用户，失败向上抛出由调用方提示。
   * @param request - 登录请求；携带用户名与密码，成功后写入令牌与用户。
   */
  login: (request: LoginRequest) => Promise<void>
  /**
   * 注册并自动登录：注册接口不返回令牌，故随后用同一凭据再登录一次。
   * @param request - 注册请求；携带用户名与密码，注册成功后自动登录并写入令牌。
   */
  register: (request: RegisterRequest) => Promise<void>
  /** 登出并按 finally 语义清空本地状态，服务端登出失败也不影响本地重置。 */
  logout: () => Promise<void>
  /** 拉取当前用户并写入 store；失败抛出，由调用方决定处理。 */
  fetchMe: () => Promise<void>
  /** 当前是否已认证（透传 store 的派生标志）。 */
  isAuthenticated: boolean
  /** 当前用户快照；未拉取到时为 null。 */
  user: User | null
}

/**
 * 登录并把令牌与用户信息写入 auth store。
 *
 * @param req - 登录请求；用户名与密码。
 * @param setAuth - 写入令牌与用户的回调；先落 token 再拉用户信息，因为 getMe 依赖 store 中已存的 token。
 */
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

/**
 * 注册成功后自动登录，并把令牌与用户信息写入 auth store。
 *
 * @param req - 注册请求；用户名与密码。
 * @param setAuth - 写入令牌与用户的回调；注册本身不返回令牌，故随后用同一凭据再登录一次。
 */
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

/**
 * 登出并清空本地认证状态；无论服务端登出是否成功，本地状态都要清干净。
 *
 * @param clearAuth - 清空 auth store 的回调；在 finally 中调用，保证服务端登出失败时本地也会重置。
 */
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

/**
 * 拉取当前用户并写入 auth store。
 *
 * @param setUser - 写入当前用户的回调；请求失败会抛出，由调用方决定如何处理。
 */
async function fetchCurrentUser(setUser: (user: User) => void): Promise<void> {
  const me = await userApi.getMe()
  setUser(me)
}

/**
 * 认证动作集合：登录、注册与登出，并同步维护 auth store 中的令牌与用户信息。
 *
 * @returns login / register / logout / fetchMe 四个动作与当前认证态快照；登出无论服务端结果如何都会清空本地状态。
 */
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
