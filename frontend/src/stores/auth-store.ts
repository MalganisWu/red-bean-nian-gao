import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import type { User } from '@/types/api'
import { TOKEN_KEY } from '@/lib/constants'

interface AuthState {
  token: string | null
  user: User | null
  isAuthenticated: boolean
}

interface AuthActions {
  setAuth: (token: string, user: User) => void
  clearAuth: () => void
  setToken: (token: string) => void
  setUser: (user: User) => void
}

type AuthStore = AuthState & AuthActions

/** 认证状态 store；token 持久化在 localStorage，`isAuthenticated` 初值即由它的存在性推导。 */
export const useAuthStore = create<AuthStore>()(createAuthStore)

function createAuthStore(set: Parameters<StateCreator<AuthStore>>[0]): AuthStore {
  /** 登录成功后写入 token 与用户，并把 token 持久化到 localStorage。 */
  function setAuth(token: string, user: User): void {
    localStorage.setItem(TOKEN_KEY, token)
    set({ token, user, isAuthenticated: true })
  }

  /** 退出登录：清除持久化的 token 与内存中的认证状态。 */
  function clearAuth(): void {
    localStorage.removeItem(TOKEN_KEY)
    set({ token: null, user: null, isAuthenticated: false })
  }

  /** 只更新 token（如刷新后回填），并标记为已认证。 */
  function setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token)
    set({ token, isAuthenticated: true })
  }

  return {
    token: localStorage.getItem(TOKEN_KEY),
    user: null,
    isAuthenticated: Boolean(localStorage.getItem(TOKEN_KEY)),

    setAuth,
    clearAuth,
    setToken,
    setUser: (user) => {
      set({ user })
    },
  }
}

/* store 一律不做热替换：React Fast Refresh 只重建"接受更新"的组件边界，没被重建的模块
   （如 useChatStream）会继续持有旧 store 实例，于是写入方与读取方各绑一份 state——
   表现就是实时投影不再跟随 SSE、流结束后同一轮出现两次。这里声明自接受并整页刷新，
   代价是开发期一次刷新，换来实例唯一（import.meta.hot 在生产构建中为 undefined）。 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
