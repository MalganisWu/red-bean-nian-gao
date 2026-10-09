import { useEffect, useRef } from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { isTokenExpiringSoon, isTokenExpired } from '@/lib/token'
import * as authApi from '@/services/api/auth'

/** JWT 自动刷新：每 60s 检查，过期前 5min 自动 refresh */
export function useAutoRefresh(): void {
  const { token, setToken, clearAuth, isAuthenticated } = useAuthStore()
  const intervalRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isAuthenticated || !token) return

    intervalRef.current = window.setInterval(async () => {
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
    }, 60_000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isAuthenticated, token, setToken, clearAuth])
}
