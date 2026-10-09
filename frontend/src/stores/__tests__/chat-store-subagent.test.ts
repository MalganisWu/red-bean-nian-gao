import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/stores/chat-store'
import type { SubAgentEnvelopePayload } from '@/types/events'

// 子 Agent 事件消费：agent_event 信封按 parent_call_id 归并到在途消息的 sub_agent section，
// 内层事件（token/reason/tool_*）复用主流程同款组装语义累积进 items.sections。

function envelope(
  parentCallId: string,
  eventType: string,
  event: unknown
): SubAgentEnvelopePayload {
  return {
    agent_id: 'agent_sub',
    agent_name: '汇率助手',
    execution_id: `SAEX_${parentCallId}`,
    parent_call_id: parentCallId,
    event_type: eventType,
    event,
  }
}

describe('chat-store appendSubAgentEvent', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
    useChatStore.getState().startStreaming('req1', 'sess1')
  })

  it('首个事件创建 sub_agent section（status running），追加到在途 sections 尾部', () => {
    useChatStore.getState().appendSubAgentEvent(envelope('call_1', 'token', { content: '查' }))
    const sections = useChatStore.getState().pendingSections
    expect(sections).toHaveLength(1)
    const sec = sections[0]
    expect(sec.type).toBe('sub_agent')
    if (sec.type !== 'sub_agent') return
    expect(sec.items.agent_name).toBe('汇率助手')
    expect(sec.items.status).toBe('running')
    expect(sec.items.sections).toMatchObject([{ type: 'content', content: '查' }])
  })

  it('同 parent_call_id 的内层事件累积进同一 section（token 拼接、reason/tool 组装）', () => {
    const s = useChatStore.getState()
    s.appendSubAgentEvent(
      envelope('call_1', 'reason', { step: 1, content: '先分析', timestamp: 1 })
    )
    s.appendSubAgentEvent(
      envelope('call_1', 'tool_start', { tool_name: 'fetch_rate', call_id: 'sub_c1', params: null })
    )
    s.appendSubAgentEvent(
      envelope('call_1', 'tool_result', {
        tool_name: 'fetch_rate',
        call_id: 'sub_c1',
        content: '7.15',
      })
    )
    s.appendSubAgentEvent(envelope('call_1', 'token', { content: '结果：' }))
    s.appendSubAgentEvent(envelope('call_1', 'token', { content: '7.15' }))

    const sections = useChatStore.getState().pendingSections
    expect(sections).toHaveLength(1)
    const sec = sections[0]
    if (sec.type !== 'sub_agent') throw new Error('expect sub_agent')
    // reason 段（含内嵌工具）+ content 段
    expect(sec.items.sections).toHaveLength(2)
    const [reason, content] = sec.items.sections
    expect(reason).toMatchObject({
      type: 'reason',
      items: [
        { itemType: 'step', content: '先分析' },
        { itemType: 'tool', tool: { callId: 'sub_c1', status: 'success', result: '7.15' } },
      ],
    })
    expect(content).toMatchObject({ type: 'content', content: '结果：7.15' })
  })

  it('不同 parent_call_id 各自独立 section', () => {
    const s = useChatStore.getState()
    s.appendSubAgentEvent(envelope('call_1', 'token', { content: 'a' }))
    s.appendSubAgentEvent(envelope('call_2', 'token', { content: 'b' }))
    const sections = useChatStore.getState().pendingSections
    expect(sections).toHaveLength(2)
  })

  it('主流程 tool_result 到达时对应 sub_agent 落定 completed + 摘要', () => {
    const s = useChatStore.getState()
    s.startToolCall('call_1', '汇率助手')
    s.appendSubAgentEvent(envelope('call_1', 'token', { content: 'USD/CNY 7.15' }))
    s.completeToolCall('call_1', 'USD/CNY 7.15 [execution_id: SAEX_call_1]')

    const sections = useChatStore.getState().pendingSections
    const sub = sections.find((x) => x.type === 'sub_agent')
    if (!sub || sub.type !== 'sub_agent') throw new Error('sub_agent section missing')
    expect(sub.items.status).toBe('completed')
    expect(sub.items.result_summary).toContain('USD/CNY 7.15')
    // 引擎协议标记 [execution_id: ...] 剥掉，不进 UI
    expect(sub.items.result_summary).not.toContain('execution_id')
  })

  it('未知 event_type / 缺字段事件安全忽略，不破坏已有 section', () => {
    const s = useChatStore.getState()
    s.appendSubAgentEvent(envelope('call_1', 'token', { content: 'a' }))
    s.appendSubAgentEvent(envelope('call_1', 'status', { content: '思考中' }))
    s.appendSubAgentEvent(envelope('call_1', 'token', { nope: true }))
    const sec = useChatStore.getState().pendingSections[0]
    if (sec.type !== 'sub_agent') throw new Error('expect sub_agent')
    expect(sec.items.sections).toMatchObject([{ type: 'content', content: 'a' }])
  })
})

describe('appendSubAgentEvent 内层工具失败', () => {
  it('内层 tool_result 带 error → 嵌套工具标记 failed', () => {
    useChatStore.getState().reset()
    useChatStore.getState().startStreaming('req1', 'sess1')
    const s = useChatStore.getState()
    s.appendSubAgentEvent(
      envelope('call_1', 'tool_start', { tool_name: 'sub_tool', call_id: 'sub_c1', params: null })
    )
    s.appendSubAgentEvent(
      envelope('call_1', 'tool_result', {
        tool_name: 'sub_tool',
        call_id: 'sub_c1',
        content: '{"error":"爆了"}',
        error: '爆了',
      })
    )
    const sec = useChatStore.getState().pendingSections[0]
    if (sec.type !== 'sub_agent') throw new Error('expect sub_agent')
    const tg = sec.items.sections.find((x) => x.type === 'tool_group')
    if (!tg || tg.type !== 'tool_group') throw new Error('inner tool_group missing')
    expect(tg.tools[0].status).toBe('failed')
    expect(tg.tools[0].error).toBe('爆了')
  })
})
