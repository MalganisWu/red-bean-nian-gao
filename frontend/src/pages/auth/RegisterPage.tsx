import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/lib/constants'
import { Button } from '@/components/retroui/Button'
import { Input } from '@/components/retroui/Input'
import { toast } from 'sonner'

/** 注册页；注册成功后按登录态继续后续跳转。 */
export function RegisterPage() {
  const navigate = useNavigate()
  const { register } = useAuth()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      await register({
        username,
        email,
        password,
        display_name: displayName,
      })
      toast.success('注册成功')
      void navigate(ROUTES.CHAT)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <h1 className="pb-1 text-center font-sans text-lg font-semibold text-foreground">注册</h1>
      <div>
        <label
          htmlFor="reg-username"
          className="mb-1.5 block text-label tracking-label text-foreground-faint"
        >
          用户名
        </label>
        <Input
          id="reg-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div>
        <label
          htmlFor="reg-email"
          className="mb-1.5 block text-label tracking-label text-foreground-faint"
        >
          邮箱
        </label>
        <Input
          id="reg-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div>
        <label
          htmlFor="reg-display-name"
          className="mb-1.5 block text-label tracking-label text-foreground-faint"
        >
          显示名称
        </label>
        <Input
          id="reg-display-name"
          autoComplete="nickname"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </div>
      <div>
        <label
          htmlFor="reg-password"
          className="mb-1.5 block text-label tracking-label text-foreground-faint"
        >
          密码
        </label>
        <Input
          id="reg-password"
          type="password"
          autoComplete="new-password"
          placeholder="至少 8 位"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <Button type="submit" variant="solid" className="w-full" disabled={loading}>
        {loading ? '注册中…' : '注册'}
      </Button>
      <p className="pt-1 text-center text-xs text-muted-foreground">
        已有账号？{' '}
        <a
          href={ROUTES.LOGIN}
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-primary underline underline-offset-2"
        >
          登录
        </a>
      </p>
    </form>
  )
}
