import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { SSEConnectionOptions } from '@/services/sse/fetch-sse'

// mock SSE 连接层：捕获 send/retry 发出的请求
const mockConnect = vi.hoisted(() => vi.fn<(options: SSEConnectionOptions) => AbortController>())
vi.mock('@/services/sse/fetch-sse', () => ({ connectSSE: mockConnect }))
vi.mock('@/services/api/chat', () => ({ cancelChat: vi.fn() }))

import { useChatStream } from '@/hooks/useChatStream'
import { useChatStore } from '@/stores/chat-store'

describe('useChatStream.retry 失败重试', () => {
  beforeEach(() => {
    mockConnect.mockReset()
    mockConnect.mockReturnValue(new AbortController())
    useChatStore.setState({
      messages: [],
      pendingSections: [],
      sessionId: null,
      activeSessionId: 'SESS_1',
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
      error: null,
      sessions: [],
      nextCursor: '',
      sessionsLoading: false,
      sessionsError: null,
    })
  })

  it('retry 重发上一次请求（同一 request 体），且不重复追加用户消息', () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.send([{ role: 'user', content: '帮我记着这件事' }], 'SESS_1')
    })
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().messages).toHaveLength(1)

    let retried = false
    act(() => {
      retried = result.current.retry()
    })

    expect(retried).toBe(true)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    const first = mockConnect.mock.calls[0][0]
    const second = mockConnect.mock.calls[1][0]
    expect(second.request).toEqual(first.request)
    // 重试不重复乐观追加用户气泡
    expect(useChatStore.getState().messages).toHaveLength(1)
  })

  it('已有会话只发送本轮最后一条 user 消息，不重复提交历史', () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.send(
        [
          { role: 'user', content: '旧问题' },
          { role: 'assistant', content: '旧回答' },
          { role: 'user', content: '本轮问题' },
        ],
        'SESS_1'
      )
    })

    const request = mockConnect.mock.calls[0][0].request
    if (!('messages' in request)) throw new Error('预期 chat 请求')
    expect(request.messages).toEqual([{ role: 'user', content: '本轮问题' }])
    expect(useChatStore.getState().messages.at(-1)?.content).toBe('本轮问题')
  })

  it('answer 轮失败后 retry 重发 /answer 请求', () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.answer('call_1', { refused: true })
    })
    expect(mockConnect).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.retry()
    })
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(mockConnect.mock.calls[1][0].url).toBe('/api/agent/chat/answer')
  })

  it('从未发送过时 retry 为空操作并返回 false', () => {
    const { result } = renderHook(() => useChatStream())
    let retried = true
    act(() => {
      retried = result.current.retry()
    })
    expect(retried).toBe(false)
    expect(mockConnect).not.toHaveBeenCalled()
  })
})
