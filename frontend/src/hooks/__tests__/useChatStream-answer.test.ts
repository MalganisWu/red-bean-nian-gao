import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ChatCancelRequest } from '@/types/chat'
import type { SSEConnectionOptions } from '@/services/sse/fetch-sse'

// mock SSE 连接层：捕获 answer 发出的请求
const mockConnect = vi.hoisted(() => vi.fn<(options: SSEConnectionOptions) => AbortController>())
const mockCancelChat = vi.hoisted(() => vi.fn<(request: ChatCancelRequest) => Promise<void>>())
vi.mock('@/services/sse/fetch-sse', () => ({ connectSSE: mockConnect }))
vi.mock('@/services/api/chat', () => ({ cancelChat: mockCancelChat }))

import { useChatStream } from '@/hooks/useChatStream'
import { useChatStore } from '@/stores/chat-store'

describe('useChatStream.answer 会话定位', () => {
  beforeEach(() => {
    mockConnect.mockReset()
    mockConnect.mockReturnValue(new AbortController())
    mockCancelChat.mockReset()
    mockCancelChat.mockResolvedValue(undefined)
    useChatStore.getState().reset()
    useChatStore.setState({
      messages: [],
      pendingSections: [],
      sessionId: null, // 刷新恢复后 storeSessionId 为 null
      activeSessionId: 'SESS_recovered', // 但侧栏打开了会话
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
      error: null,
      cardSubmission: null,
      sessions: [],
      nextCursor: '',
      sessionsLoading: false,
      sessionsError: null,
    })
  })

  it('storeSessionId 为 null（刷新恢复）时用 activeSessionId 定位会话并发出 /answer', () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.answer('call_1', { answers: { q1: { kind: 'option', value: '是' } } })
    })

    expect(mockConnect).toHaveBeenCalledTimes(1)
    const opts = mockConnect.mock.calls[0][0]
    if (!('interaction_id' in opts.request)) throw new Error('预期 answer 请求')
    expect(opts.url).toBe('/api/agent/chat/answer')
    expect(opts.request.session_id).toBe('SESS_recovered')
    expect(opts.request.interaction_id).toBe('call_1')
    expect(useChatStore.getState().cardSubmission).toMatchObject({
      interactionId: 'call_1',
      state: 'submitting',
      answers: { q1: { kind: 'option', value: '是' } },
    })
  })

  it('storeSessionId 已设置（活流）时优先用它', () => {
    useChatStore.setState({ sessionId: 'SESS_live' })
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.answer('call_1', { refused: true })
    })
    const opts = mockConnect.mock.calls[0][0]
    if (!('interaction_id' in opts.request)) throw new Error('预期 answer 请求')
    expect(opts.request.session_id).toBe('SESS_live')
    expect(opts.request.refused).toBe(true)
  })

  it('START 后立即回显 accepted，DONE 后才持久化 answered', () => {
    useChatStore.setState({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          sections: [
            {
              type: 'card',
              timestamp: 0,
              card: {
                interaction_id: 'call_1',
                status: 'pending',
                questions: [{ id: 'q1', text: '确认？', options: ['是', '否'] }],
                answers: null,
              },
            },
          ],
          timestamp: 0,
        },
      ],
    })

    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.answer('call_1', { answers: { q1: { kind: 'option', value: '是' } } })
    })
    const opts = mockConnect.mock.calls[0][0]
    expect(useChatStore.getState().cardSubmission?.state).toBe('submitting')
    expect(cardStatus()).toBe('pending')

    act(() => {
      opts.onEvent({
        eventType: 'start',
        data: { request_id: 'r1', session_id: 'SESS_recovered', trace_id: 'trace-1' },
      })
    })
    expect(useChatStore.getState().cardSubmission?.state).toBe('accepted')
    expect(cardStatus()).toBe('pending')

    act(() => {
      opts.onEvent({ eventType: 'done', data: { tokens_used: 1, session_id: 'SESS_recovered' } })
    })
    expect(cardStatus()).toBe('answered')
    expect(useChatStore.getState().cardSubmission).toBeNull()
  })

  it('answer DONE 先把续跑内容合回原 Process，再持久化 answered', () => {
    useChatStore.setState({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          sections: [
            {
              type: 'card',
              timestamp: 0,
              card: {
                interaction_id: 'call_1',
                status: 'pending',
                questions: [{ id: 'q1', text: '确认？', options: ['是'] }],
                answers: null,
              },
            },
          ],
          timestamp: 0,
        },
      ],
    })

    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.answer('call_1', { answers: { q1: { kind: 'option', value: '是' } } })
    })
    const opts = mockConnect.mock.calls[0][0]
    act(() => {
      opts.onEvent({
        eventType: 'start',
        data: { request_id: 'r1', session_id: 'SESS_recovered', trace_id: 'trace-1' },
      })
      opts.onEvent({ eventType: 'token', data: { content: '继续后的最终结果' } })
      opts.onEvent({ eventType: 'done', data: { tokens_used: 1, session_id: 'SESS_recovered' } })
    })

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0].sections).toMatchObject([
      { type: 'card', card: { status: 'answered' } },
      { type: 'content', content: '继续后的最终结果' },
    ])
  })

  it('answer 流错误时丢弃半截续跑、恢复 pending 并保留答案用于重试', () => {
    useChatStore.setState({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          sections: [
            {
              type: 'card',
              timestamp: 0,
              card: {
                interaction_id: 'call_1',
                status: 'pending',
                questions: [{ id: 'q1', text: '确认？', options: ['是', '否'] }],
                answers: null,
              },
            },
          ],
          timestamp: 0,
        },
      ],
    })
    let onErrorCb: ((err: Error) => void) | undefined
    mockConnect.mockImplementation((opts: { onError?: (e: Error) => void }) => {
      onErrorCb = opts.onError
      return new AbortController()
    })

    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.answer('call_1', { answers: { q1: { kind: 'option', value: '是' } } })
    })
    act(() => {
      useChatStore.setState({
        pendingSections: [{ type: 'content', content: '我已经处理到一半', timestamp: 0 }],
      })
    })

    act(() => {
      if (!onErrorCb) throw new Error('onError 回调未注册')
      onErrorCb(new Error('SSE connection failed: 500'))
    })

    expect(cardStatus()).toBe('pending')
    expect(useChatStore.getState().pendingSections).toHaveLength(0)
    expect(useChatStore.getState().cardSubmission).toMatchObject({
      interactionId: 'call_1',
      state: 'error',
      answers: { q1: { kind: 'option', value: '是' } },
      error: 'SSE connection failed: 500',
    })
  })

  it('answer 已收到 START 后失败时保留已消费答案，并在同一 Process 标记续跑停止', () => {
    useChatStore.setState({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          sections: [
            {
              type: 'card',
              timestamp: 0,
              card: {
                interaction_id: 'call_1',
                status: 'pending',
                questions: [{ id: 'q1', text: '确认？', options: ['是'] }],
                answers: null,
              },
            },
          ],
          timestamp: 0,
        },
      ],
    })

    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.answer('call_1', { answers: { q1: { kind: 'option', value: '是' } } })
    })
    const opts = mockConnect.mock.calls[0][0]
    act(() => {
      opts.onEvent({
        eventType: 'start',
        data: { request_id: 'r1', session_id: 'SESS_recovered', trace_id: 'trace-1' },
      })
      opts.onEvent({ eventType: 'token', data: { content: '已处理一部分' } })
      opts.onEvent({ eventType: 'error', data: { code: 5000, message: '续跑失败' } })
    })

    expect(cardStatus()).toBe('answered')
    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0].meta?.process_status).toBe('cancelled')
    expect(useChatStore.getState().cardSubmission).toBeNull()
  })

  it('DONE 前把未返回结果的 Tool 结算为 incomplete', () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.send([{ role: 'user', content: '执行工具' }])
    })
    const opts = mockConnect.mock.calls[0][0]

    act(() => {
      opts.onEvent({
        eventType: 'start',
        data: { request_id: 'r1', session_id: 'SESS_recovered', trace_id: 'trace-1' },
      })
      opts.onEvent({
        eventType: 'tool_start',
        data: { tool_name: 'slow_tool', call_id: 'c1', params: null },
      })
      opts.onEvent({ eventType: 'done', data: { tokens_used: 1, session_id: 'SESS_recovered' } })
    })

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === 'assistant')
    const group = assistant?.sections?.find((section) => section.type === 'tool_group')
    expect(group?.type).toBe('tool_group')
    if (group?.type !== 'tool_group') return
    expect(group.tools[0].status).toBe('incomplete')
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('普通 ERROR 结算 Tool 并把本轮标记为 cancelled', () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.send([{ role: 'user', content: '执行工具' }])
    })
    const opts = mockConnect.mock.calls[0][0]

    act(() => {
      opts.onEvent({
        eventType: 'start',
        data: { request_id: 'r1', session_id: 'SESS_recovered', trace_id: 'trace-1' },
      })
      opts.onEvent({
        eventType: 'tool_start',
        data: { tool_name: 'slow_tool', call_id: 'c1', params: null },
      })
      opts.onEvent({ eventType: 'error', data: { code: 5000, message: '服务中断' } })
    })

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === 'assistant')
    const group = assistant?.sections?.find((section) => section.type === 'tool_group')
    expect(group?.type).toBe('tool_group')
    if (group?.type !== 'tool_group') return
    expect(group.tools[0].status).toBe('incomplete')
    expect(assistant?.meta?.process_status).toBe('cancelled')
  })

  it('用户取消时立即结算 Tool、保留 partial，并向后端发送 request_id', async () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.send([{ role: 'user', content: '执行工具' }])
    })
    const opts = mockConnect.mock.calls[0][0]

    act(() => {
      opts.onEvent({
        eventType: 'start',
        data: { request_id: 'r-cancel', session_id: 'SESS_recovered', trace_id: 'trace-cancel' },
      })
      opts.onEvent({
        eventType: 'tool_start',
        data: { tool_name: 'slow_tool', call_id: 'c1', params: null },
      })
      opts.onEvent({ eventType: 'token', data: { content: '已完成一部分' } })
    })
    await act(async () => {
      await result.current.cancel()
    })

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === 'assistant')
    const group = assistant?.sections?.find((section) => section.type === 'tool_group')
    expect(group?.type).toBe('tool_group')
    if (group?.type !== 'tool_group') return
    expect(group.tools[0].status).toBe('incomplete')
    expect(assistant?.meta?.process_status).toBe('cancelled')
    expect(mockCancelChat).toHaveBeenCalledWith({ request_id: 'r-cancel' })
  })

  it('START 后 transport 直接关闭时结算 Tool 并显示断线错误', () => {
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.send([{ role: 'user', content: '执行工具' }])
    })
    const opts = mockConnect.mock.calls[0][0]

    act(() => {
      opts.onEvent({
        eventType: 'start',
        data: { request_id: 'r-close', session_id: 'SESS_recovered', trace_id: 'trace-close' },
      })
      opts.onEvent({
        eventType: 'tool_start',
        data: { tool_name: 'slow_tool', call_id: 'c1', params: null },
      })
      opts.onClose()
    })

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === 'assistant')
    const group = assistant?.sections?.find((section) => section.type === 'tool_group')
    expect(group?.type).toBe('tool_group')
    if (group?.type !== 'tool_group') return
    expect(group.tools[0].status).toBe('incomplete')
    expect(assistant?.meta?.process_status).toBe('cancelled')
    expect(useChatStore.getState().error?.message).toBe('连接已中断，请重试。')
  })
})

function cardStatus(): string | undefined {
  const section = useChatStore
    .getState()
    .messages[0]?.sections?.find((item) => item.type === 'card')
  return section?.type === 'card' ? section.card.status : undefined
}
