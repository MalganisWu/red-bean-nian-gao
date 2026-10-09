import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatCancelRequest } from '@/types/chat'
import type { SessionDetail } from '@/services/api/session'
import type { SSEConnectionOptions } from '@/services/sse/fetch-sse'

const mockConnect = vi.hoisted(() => vi.fn<(options: SSEConnectionOptions) => AbortController>())
const mockCancelChat = vi.hoisted(() => vi.fn<(request: ChatCancelRequest) => Promise<void>>())
const mockFetchSession = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<SessionDetail>>())

vi.mock('@/services/sse/fetch-sse', () => ({ connectSSE: mockConnect }))
vi.mock('@/services/api/chat', () => ({ cancelChat: mockCancelChat }))
vi.mock('@/services/api/session', () => ({
  fetchSessions: vi.fn(),
  fetchSession: mockFetchSession,
}))

import { useChatStream } from '@/hooks/useChatStream'
import { useChatStore } from '@/stores/chat-store'

describe('useChatStream 会话导航生命周期', () => {
  beforeEach(() => {
    mockConnect.mockReset()
    mockCancelChat.mockReset()
    mockFetchSession.mockReset()
    mockFetchSession.mockResolvedValue({ id: 'session-next', messages: [] })
    useChatStore.getState().reset()
  })

  it('新建会话会 abort 尚未 START 的连接，并忽略旧流迟到的 START/TOKEN/DONE', () => {
    const abort = vi.fn()
    const controller = new AbortController()
    vi.spyOn(controller, 'abort').mockImplementation(abort)
    mockConnect.mockReturnValue(controller)
    const { result } = renderHook(() => useChatStream())

    act(() => {
      result.current.send([{ role: 'user', content: '旧请求' }])
    })
    const oldStream = mockConnect.mock.calls[0][0]

    act(() => {
      useChatStore.getState().newSession()
    })
    expect(abort).toHaveBeenCalledTimes(1)

    act(() => {
      oldStream.onEvent({
        eventType: 'start',
        data: { request_id: 'request-old', session_id: 'session-old', trace_id: 'trace-old' },
      })
      oldStream.onEvent({ eventType: 'token', data: { content: '不应出现' } })
      oldStream.onEvent({
        eventType: 'done',
        data: { tokens_used: 1, session_id: 'session-old' },
      })
    })

    expect(useChatStore.getState()).toMatchObject({
      messages: [],
      pendingSections: [],
      activeSessionId: null,
      sessionId: null,
      requestId: null,
      isStreaming: false,
    })
  })

  it('切换会话会 abort 当前连接，并阻止旧流写入目标会话', async () => {
    const abort = vi.fn()
    const controller = new AbortController()
    vi.spyOn(controller, 'abort').mockImplementation(abort)
    mockConnect.mockReturnValue(controller)
    const { result } = renderHook(() => useChatStream())

    act(() => {
      result.current.send([{ role: 'user', content: '旧会话消息' }], 'session-old')
    })
    const oldStream = mockConnect.mock.calls[0][0]
    act(() => {
      oldStream.onEvent({
        eventType: 'start',
        data: { request_id: 'request-old', session_id: 'session-old', trace_id: 'trace-old' },
      })
    })

    await act(async () => {
      await useChatStore.getState().switchSession('session-next')
    })
    expect(abort).toHaveBeenCalledTimes(1)

    act(() => {
      oldStream.onEvent({ eventType: 'token', data: { content: '串入新会话' } })
      oldStream.onEvent({
        eventType: 'done',
        data: { tokens_used: 1, session_id: 'session-old' },
      })
    })

    expect(useChatStore.getState()).toMatchObject({
      messages: [],
      pendingSections: [],
      activeSessionId: 'session-next',
      sessionId: 'session-next',
      isStreaming: false,
    })
  })
})

describe('useChatStream 取消失败', () => {
  beforeEach(() => {
    mockConnect.mockReset()
    mockCancelChat.mockReset()
    useChatStore.getState().reset()
  })

  it('取消接口失败时 Promise 仍正常结束，并给出用户可见错误', async () => {
    mockConnect.mockReturnValue(new AbortController())
    mockCancelChat.mockRejectedValue(new Error('cancel endpoint unavailable'))
    const { result } = renderHook(() => useChatStream())

    act(() => {
      result.current.send([{ role: 'user', content: '生成较长内容' }])
    })
    const stream = mockConnect.mock.calls[0][0]
    act(() => {
      stream.onEvent({
        eventType: 'start',
        data: {
          request_id: 'request-cancel',
          session_id: 'session-current',
          trace_id: 'trace-current',
        },
      })
    })

    await expect(result.current.cancel()).resolves.toBeUndefined()

    const error = useChatStore.getState().error
    expect(error?.code).toBe(500)
    expect(error?.message).toContain('cancel endpoint unavailable')
    expect(useChatStore.getState().isStreaming).toBe(false)
  })
})
