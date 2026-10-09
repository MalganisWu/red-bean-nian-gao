import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { SSEConnectionOptions } from '@/services/sse/fetch-sse'

// mock SSE 连接层：捕获 send 后的 onEvent 回调，手工喂事件
const mockConnect = vi.hoisted(() => vi.fn<(options: SSEConnectionOptions) => AbortController>())
vi.mock('@/services/sse/fetch-sse', () => ({ connectSSE: mockConnect }))
vi.mock('@/services/api/chat', () => ({ cancelChat: vi.fn() }))

import { useChatStream } from '@/hooks/useChatStream'
import { useChatStore } from '@/stores/chat-store'

function startAndCapture(): SSEConnectionOptions {
  const { result } = renderHook(() => useChatStream())
  act(() => {
    result.current.send([{ role: 'user', content: '查汇率' }])
  })
  const opts = mockConnect.mock.calls[0][0]
  act(() => {
    opts.onEvent({
      eventType: 'start',
      data: { request_id: 'r1', session_id: 's1', trace_id: 'trace-1' },
    })
  })
  return opts
}

describe('useChatStream agent_event 消费', () => {
  beforeEach(() => {
    mockConnect.mockReset()
    mockConnect.mockReturnValue(new AbortController())
    useChatStore.getState().reset()
  })

  it('agent_event 信封 → store 建 sub_agent section 并累积内层事件', () => {
    const opts = startAndCapture()
    act(() => {
      opts.onEvent({
        eventType: 'tool_start',
        data: { tool_name: '汇率助手', call_id: 'call_1', params: null },
      })
      opts.onEvent({
        eventType: 'agent_event',
        data: {
          agent_id: 'agent_sub',
          agent_name: '汇率助手',
          execution_id: 'SAEX_1',
          parent_call_id: 'call_1',
          event_type: 'reason',
          event: { step: 1, content: '分析请求', timestamp: 1 },
        },
      })
      opts.onEvent({
        eventType: 'agent_event',
        data: {
          agent_id: 'agent_sub',
          agent_name: '汇率助手',
          execution_id: 'SAEX_1',
          parent_call_id: 'call_1',
          event_type: 'token',
          event: { content: '7.15' },
        },
      })
      opts.onEvent({
        eventType: 'tool_result',
        data: { tool_name: '汇率助手', call_id: 'call_1', content: 'USD/CNY 7.15' },
      })
    })

    const sections = useChatStore.getState().pendingSections
    const sub = sections.find((s) => s.type === 'sub_agent')
    if (!sub || sub.type !== 'sub_agent') throw new Error('sub_agent section missing')
    expect(sub.items.agent_name).toBe('汇率助手')
    expect(sub.items.status).toBe('completed') // 主流程 tool_result 落定
    expect(sub.items.sections).toHaveLength(2) // reason + content
  })

  it('畸形信封（缺 event_type）安全跳过', () => {
    const opts = startAndCapture()
    act(() => {
      opts.onEvent({
        eventType: 'agent_event',
        data: { agent_id: 'a', agent_name: 'n', execution_id: 'e', parent_call_id: 'c' },
      })
    })
    expect(useChatStore.getState().pendingSections).toHaveLength(0)
  })
})

describe('useChatStream 工具失败分派', () => {
  beforeEach(() => {
    mockConnect.mockReset()
    mockConnect.mockReturnValue(new AbortController())
    useChatStore.getState().reset()
  })

  it('tool_result 带 error → 工具标记 failed，不是 success', () => {
    const opts = startAndCapture()
    act(() => {
      opts.onEvent({
        eventType: 'tool_start',
        data: { tool_name: 'broken', call_id: 'call_9', params: null },
      })
      opts.onEvent({
        eventType: 'tool_result',
        data: {
          tool_name: 'broken',
          call_id: 'call_9',
          content: '{"error":"连接被拒绝"}',
          error: '连接被拒绝',
        },
      })
    })
    const sections = useChatStore.getState().pendingSections
    const tg = sections.find((s) => s.type === 'tool_group')
    if (!tg || tg.type !== 'tool_group') throw new Error('tool_group missing')
    expect(tg.tools[0].status).toBe('failed')
    expect(tg.tools[0].error).toBe('连接被拒绝')
  })

  it('tool_result 无 error → 维持 success（回归保护）', () => {
    const opts = startAndCapture()
    act(() => {
      opts.onEvent({
        eventType: 'tool_start',
        data: { tool_name: 'ok_tool', call_id: 'call_8', params: null },
      })
      opts.onEvent({
        eventType: 'tool_result',
        data: { tool_name: 'ok_tool', call_id: 'call_8', content: '结果' },
      })
    })
    const tg = useChatStore.getState().pendingSections.find((s) => s.type === 'tool_group')
    if (!tg || tg.type !== 'tool_group') throw new Error('tool_group missing')
    expect(tg.tools[0].status).toBe('success')
  })
})
