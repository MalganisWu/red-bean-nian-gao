import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/lib/constants'
import { Button } from '@/components/retroui/Button'
import { Input } from '@/components/retroui/Input'
import { toast } from 'sonner'

/** 登录页；提交成功后进入主应用。 */
export function LoginPage() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      await login({ username, password })
      toast.success('登录成功')
      void navigate(ROUTES.CHAT)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <h1 className="pb-1 text-center font-sans text-lg font-semibold text-foreground">登录</h1>
      <div>
        <label
          htmlFor="login-username"
          className="mb-1.5 block text-label tracking-label text-foreground-faint"
        >
          用户名
        </label>
        <Input
          id="login-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div>
        <label
          htmlFor="login-password"
          className="mb-1.5 block text-label tracking-label text-foreground-faint"
        >
          密码
        </label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <Button type="submit" variant="solid" className="w-full" disabled={loading}>
        {loading ? '登录中…' : '登录'}
      </Button>
      <p className="pt-1 text-center text-xs text-muted-foreground">
        还没有账号？{' '}
        <a
          href={ROUTES.REGISTER}
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-primary underline underline-offset-2"
        >
          注册
        </a>
      </p>
    </form>
  )
}
