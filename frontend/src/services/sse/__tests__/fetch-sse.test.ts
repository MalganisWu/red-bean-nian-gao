import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FetchEventSourceInit } from '@microsoft/fetch-event-source'

const mockFetchEventSource = vi.hoisted(() =>
  vi.fn<(input: RequestInfo, init: FetchEventSourceInit) => Promise<void>>()
)
vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource: mockFetchEventSource }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => ({ token: 'tok' }) } }))

import { connectSSE } from '../fetch-sse'
import type { ChatRequest } from '@/types/chat'

// connectSSE 的 request 只需满足 ChatRequest | AnswerRequest；测试用最小 ChatRequest
const req: ChatRequest = { messages: [], session_id: 's', agent_id: 'agent_1' }

// 捕获 fetchEventSource 的 onopen 回调，测试非 2xx 的错误文案解析
function captureOnopen(): () => ((r: Response) => Promise<void>) | undefined {
  let onopenCb: ((r: Response) => Promise<void>) | undefined
  mockFetchEventSource.mockImplementation((_url, opts) => {
    onopenCb = opts.onopen
    return Promise.resolve()
  })
  return () => onopenCb
}

describe('connectSSE onopen 非 2xx 错误处理', () => {
  beforeEach(() => {
    mockFetchEventSource.mockReset()
  })

  it('非 2xx 且 body 含 message 时，报出业务 message 而非状态码', async () => {
    const getOnopen = captureOnopen()
    const onError = vi.fn()
    connectSSE({ request: req, onEvent: vi.fn(), onError, onClose: vi.fn() })

    const onopen = getOnopen()
    if (!onopen) throw new Error('onopen 回调未注册')
    const resp = new Response(JSON.stringify({ code: 4009, message: '交互不存在或已处理' }), {
      status: 409,
    })
    await onopen(resp)

    expect(onError).toHaveBeenCalledWith(new Error('交互不存在或已处理'))
  })

  it('非 2xx 且 body 不可解析时回退到状态码文案', async () => {
    const getOnopen = captureOnopen()
    const onError = vi.fn()
    connectSSE({ request: req, onEvent: vi.fn(), onError, onClose: vi.fn() })

    const onopen = getOnopen()
    if (!onopen) throw new Error('onopen 回调未注册')
    const resp = new Response('{invalid json', { status: 500 })
    await onopen(resp)

    expect(onError).toHaveBeenCalledWith(new Error('连接失败（HTTP 500），请重试'))
  })
})

describe('connectSSE 首事件超时', () => {
  beforeEach(() => {
    mockFetchEventSource.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('连接打开后长时间收不到任何事件时，报错并中止（不再无限等待）', async () => {
    mockFetchEventSource.mockImplementation((_url, opts) => {
      // 模拟半开连接：onopen 后没有任何 onmessage/onclose/onerror 回调
      void opts.onopen?.(new Response('', { status: 200 }))
      return new Promise(() => undefined)
    })
    const onError = vi.fn()
    const onClose = vi.fn()
    const ctrl = connectSSE({ request: req, onEvent: vi.fn(), onError, onClose })

    await vi.advanceTimersByTimeAsync(30_001)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(ctrl.signal.aborted).toBe(true)
  })

  it('收到首个事件后超时不再触发，正常流不受影响', async () => {
    mockFetchEventSource.mockImplementation((_url, opts) => {
      const event = {
        id: '',
        event: 'start',
        data: JSON.stringify({ request_id: 'r', session_id: 's', trace_id: 't' }),
      }
      void opts.onopen?.(new Response('', { status: 200 }))
      opts.onmessage?.(event)
      return new Promise(() => undefined)
    })
    const onError = vi.fn()
    const onEvent = vi.fn()
    const ctrl = connectSSE({ request: req, onEvent, onError, onClose: vi.fn() })

    expect(onEvent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_001)

    expect(onError).not.toHaveBeenCalled()
    expect(ctrl.signal.aborted).toBe(false)
  })
})
