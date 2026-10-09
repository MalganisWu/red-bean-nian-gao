import { useNavigate } from 'react-router-dom'
import { BackLink } from '@/components/layout/BackLink'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/lib/constants'

/** 个人信息：沿用 Quiet Tool 的无衬线排版与细线结构。 */
export function ProfilePage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  return (
    <div className="flex min-h-dvh bg-background">
      <div className="mx-auto w-full max-w-xl px-6">
        <div className="pt-4">
          <BackLink label="返回聊天" onClick={() => void navigate(ROUTES.CHAT)} />
        </div>
        <div className="border-b border-border-strong pb-4 pt-3">
          <h1 className="font-sans text-2xl font-semibold text-foreground">个人信息</h1>
        </div>

        <dl className="py-2">
          <div className="flex items-baseline justify-between border-b border-border py-3.5">
            <dt className="text-label tracking-label text-foreground-faint">用户名</dt>
            <dd className="min-w-0 break-all text-right font-mono text-xs text-foreground-body">
              {user?.username ?? '—'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between border-b border-border py-3.5">
            <dt className="text-label tracking-label text-foreground-faint">显示名称</dt>
            <dd className="min-w-0 break-words text-right font-sans text-sm text-foreground [overflow-wrap:anywhere]">
              {user?.display_name ?? '—'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between border-b border-border py-3.5">
            <dt className="text-label tracking-label text-foreground-faint">邮箱</dt>
            <dd className="min-w-0 break-all text-right font-mono text-xs text-foreground-body">
              {user?.email ?? '—'}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
