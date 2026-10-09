import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiCall } from '@/services/api/client'
import { useAuthStore } from '@/stores/auth-store'

const fetchMock = vi.fn<typeof fetch>()

function okResponse(): Response {
  return new Response(JSON.stringify({ code: 200, data: { message: 'ok' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('apiCall 请求头', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    useAuthStore.getState().clearAuth()
  })

  it('无请求体时不发送 application/json Content-Type', async () => {
    await apiCall('/api/logout', { method: 'POST' }, () => undefined)

    const options = fetchMock.mock.calls[0]?.[1]
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false)
  })

  it('JSON 请求体仍自动发送 application/json Content-Type', async () => {
    await apiCall(
      '/api/login',
      { method: 'POST', body: JSON.stringify({ username: 'u', password: 'p' }) },
      () => undefined
    )

    const options = fetchMock.mock.calls[0]?.[1]
    expect(new Headers(options?.headers).get('Content-Type')).toBe('application/json')
  })

  it('401 时清空认证并抛出 AppError（跳转由 RequireAuth 响应式完成）', async () => {
    useAuthStore.getState().setToken('expired-token')
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))

    await expect(apiCall('/api/me', {}, () => undefined)).rejects.toMatchObject({
      name: 'AppError',
      message: '登录已过期，请重新登录',
    })
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})
