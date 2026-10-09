import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'

import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/lib/constants'
import { useAuthStore } from '@/stores/auth-store'

/** 保护路由并在刷新后恢复当前用户，避免各页面分别处理账户占位。 */
export function RequireAuth(): React.ReactElement {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const user = useAuthStore((state) => state.user)
  const { fetchMe } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [loadState, setLoadState] = useState<'loading' | 'error'>('loading')

  useEffect(() => {
    if (!isAuthenticated || user) return

    let active = true
    void fetchMe().catch(() => {
      if (active) setLoadState('error')
    })

    return () => {
      active = false
    }
  }, [attempt, fetchMe, isAuthenticated, user])

  if (!isAuthenticated) return <Navigate to={ROUTES.LOGIN} replace />
  if (user) return <Outlet />

  if (loadState === 'error') {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6 text-center">
        <div role="alert">
          <p className="font-sans text-sm text-foreground-body">账户信息加载失败</p>
          <button
            type="button"
            className="mt-3 min-h-11 cursor-pointer border-0 bg-transparent px-2 text-xs font-medium text-action-confirm hover:text-action-confirm-hover"
            onClick={() => {
              setLoadState('loading')
              setAttempt((value) => value + 1)
            }}
          >
            重试
          </button>
        </div>
      </main>
    )
  }

  return (
    <main
      role="status"
      className="grid min-h-dvh place-items-center bg-background px-6 text-center font-sans text-sm text-foreground-muted"
    >
      正在加载账户信息…
    </main>
  )
}
