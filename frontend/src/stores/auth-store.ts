import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import type { User } from '@/types/api'
import { TOKEN_KEY } from '@/lib/constants'

/** 认证状态字段：持久化 token、当前用户与派生的已认证标志。 */
interface AuthState {
  /** 当前访问令牌；取自 localStorage，null 表示未登录。 */
  token: string | null
  /** 当前登录用户；登录后由接口回填，刷新时先为 null 直到重新拉取。 */
  user: User | null
  /** 是否已认证的派生标志；由 token 的存在性推导，供路由守卫直接读取。 */
  isAuthenticated: boolean
}

/** 认证状态的可写动作：登录写入、退出清空，以及只更新 token 或 user 的局部动作。 */
interface AuthActions {
  /**
   * 登录成功后写入 token 与用户，并把 token 持久化到 localStorage，标记为已认证。
   * @param token - 服务端签发的访问令牌，会写入 localStorage。
   * @param user - 当前登录用户信息，仅存内存不持久化。
   */
  setAuth: (token: string, user: User) => void
  /** 退出登录：清除持久化的 token 与内存中的用户和认证状态。 */
  clearAuth: () => void
  /**
   * 只更新 token（如刷新后回填），同步持久化并标记为已认证，不改动 user。
   * @param token - 待回填的访问令牌，同步写入 localStorage 并置为已认证。
   */
  setToken: (token: string) => void
  /**
   * 只更新内存中的用户信息，不改动 token 与持久化状态。
   * @param user - 待写入的当前登录用户信息，仅存内存不持久化。
   */
  setUser: (user: User) => void
}

/** 认证 store 的完整形状：状态字段与动作的合成类型。 */
type AuthStore = AuthState & AuthActions

/** 认证状态 store；token 持久化在 localStorage，`isAuthenticated` 初值即由它的存在性推导。 */
export const useAuthStore = create<AuthStore>()(createAuthStore)

/**
 * 构造认证 store 的初始状态与动作；token 从 localStorage 回填，使刷新后仍保持登录。
 *
 * @param set - Zustand 提供的局部状态写入函数；动作据此合并 token、user 与 isAuthenticated。
 * @returns 含初始状态与 setAuth / clearAuth / setToken / setUser 动作的认证 store。
 */
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
