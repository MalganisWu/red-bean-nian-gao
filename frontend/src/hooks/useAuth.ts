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

/** 认证动作集合：登录、注册与登出，并同步维护 auth store 中的令牌与用户信息。 */
export function useAuth(): AuthControls {
  const { setAuth, clearAuth, setUser, isAuthenticated, user } = useAuthStore()

  const login = useCallback(
    async (req: LoginRequest): Promise<void> => {
      const res = await authApi.login(req)
      // 先存 token，再获取用户信息（getMe 需要读取 store 中的 token）
      useAuthStore.getState().setToken(res.token)
      const me = await userApi.getMe()
      setAuth(res.token, me)
    },
    [setAuth]
  )

  const register = useCallback(
    async (req: RegisterRequest): Promise<void> => {
      await authApi.register(req)
      // 注册成功后自动登录
      const loginRes = await authApi.login({ username: req.username, password: req.password })
      useAuthStore.getState().setToken(loginRes.token)
      const me = await userApi.getMe()
      setAuth(loginRes.token, me)
    },
    [setAuth]
  )

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout()
    } finally {
      // 用户级会话、任务与已读状态不能泄漏到下一次登录。
      useChatStore.getState().reset()
      useTaskStore.getState().reset()
      clearAuth()
    }
  }, [clearAuth])

  const fetchMe = useCallback(async (): Promise<void> => {
    const me = await userApi.getMe()
    setUser(me)
  }, [setUser])

  return { login, register, logout, fetchMe, isAuthenticated, user }
}
