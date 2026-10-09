import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RequireAuth } from '../RequireAuth'

const fetchMe = vi.fn<() => Promise<void>>()

interface MockAuthState {
  isAuthenticated: boolean
  user: { username: string } | null
}

let authState: MockAuthState

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: <TResult,>(selector: (state: MockAuthState) => TResult): TResult =>
    selector(authState),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ fetchMe }),
}))

function GuardRoutes(): React.ReactElement {
  return (
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/chat" element={<p>聊天页面</p>} />
        </Route>
        <Route path="/login" element={<p>登录页面</p>} />
      </Routes>
    </MemoryRouter>
  )
}

function renderGuard(): ReturnType<typeof render> {
  return render(<GuardRoutes />)
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState = { isAuthenticated: true, user: null }
    fetchMe.mockReturnValue(new Promise<void>(() => undefined))
  })

  it('未登录时跳转登录页', () => {
    authState.isAuthenticated = false
    renderGuard()
    expect(screen.getByText('登录页面')).toBeInTheDocument()
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('已有用户信息时直接进入受保护页面', () => {
    authState.user = { username: 'redbean' }
    renderGuard()
    expect(screen.getByText('聊天页面')).toBeInTheDocument()
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('账户信息恢复成功后进入受保护页面', async () => {
    fetchMe.mockImplementation(async () => {
      authState.user = { username: 'redbean' }
    })
    const view = renderGuard()

    await waitFor(() => expect(fetchMe).toHaveBeenCalledTimes(1))
    view.rerender(<GuardRoutes />)

    expect(screen.getByText('聊天页面')).toBeInTheDocument()
  })

  it('刷新后恢复账户信息，并为失败提供重试', async () => {
    fetchMe.mockRejectedValue(new Error('network error'))
    renderGuard()

    expect(screen.getByRole('status')).toHaveTextContent('正在加载账户信息')
    expect(await screen.findByRole('alert')).toHaveTextContent('账户信息加载失败')

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(fetchMe).toHaveBeenCalledTimes(2))
  })
})
