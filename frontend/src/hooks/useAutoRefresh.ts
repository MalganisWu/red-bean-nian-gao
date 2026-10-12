import { useEffect, useRef } from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { isTokenExpiringSoon, isTokenExpired } from '@/lib/token'
import * as authApi from '@/services/api/auth'

/** JWT 自动刷新：每 60s 检查，过期前 5min 自动 refresh */
export function useAutoRefresh(): void {
  const { token, setToken, clearAuth, isAuthenticated } = useAuthStore()
  const intervalRef = useRef<number | null>(null)

  useEffect(watchTokenExpiry, [isAuthenticated, token, setToken, clearAuth])

  /** 每 60s 检查一次 token，过期前 5 分钟自动 refresh；退出登录或卸载时清除定时器。 */
  function watchTokenExpiry(): (() => void) | undefined {
    if (!isAuthenticated || !token) return undefined

    /** 检查当前 token：已过期则刷新，失败即登出；临期则刷新，失败继续沿用。 */
    async function refreshTokenIfNeeded(): Promise<void> {
      const currentToken = useAuthStore.getState().token
      if (!currentToken) return

      if (isTokenExpired(currentToken)) {
        // Token 完全过期，尝试 refresh（后端允许过期 token refresh）
        try {
          const res = await authApi.refresh(currentToken)
          setToken(res.token)
        } catch {
          clearAuth()
        }
      } else if (isTokenExpiringSoon(currentToken)) {
        try {
          const res = await authApi.refresh(currentToken)
          setToken(res.token)
        } catch {
          // Refresh 失败但 token 还没过期，继续使用
        }
      }
    }

    intervalRef.current = window.setInterval(refreshTokenIfNeeded, 60_000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }
}
