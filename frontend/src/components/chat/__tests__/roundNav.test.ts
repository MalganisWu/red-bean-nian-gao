import { describe, it, expect } from 'vitest'
import { roundNavItems } from '@/components/chat/roundNav'
import type { DisplayMessage, MessageSection } from '@/types/chat'

const user = (content: string, timestamp = 1000): DisplayMessage => ({
  id: `msg_${timestamp}`,
  role: 'user',
  content,
  timestamp,
})

const assistant = (
  sections: MessageSection[],
  extra?: Partial<DisplayMessage>
): DisplayMessage => ({
  id: 'msg_a',
  role: 'assistant',
  sections,
  timestamp: 2000,
  ...extra,
})

const reasonSection = (ts = 1000): MessageSection => ({
  type: 'reason',
  items: [{ itemType: 'step', content: '想' }],
  timestamp: ts,
  duration: 500,
})

describe('roundNavItems：轮次导航数据派生', () => {
  it('每条 user 消息一根横杠；answer 取紧随 assistant 的最后一个 content section', () => {
    const items = roundNavItems([
      user('第一问'),
      assistant([
        reasonSection(),
        { type: 'content', content: '中间叙述', timestamp: 1600 },
        { type: 'content', content: '最终回答', timestamp: 1800, duration: 200 },
      ]),
      user('第二问'),
      assistant([{ type: 'content', content: '直接回答', timestamp: 3000 }]),
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      messageId: 'msg_1000',
      question: '第一问',
      answer: '最终回答',
    })
    expect(items[1]).toMatchObject({ question: '第二问', answer: '直接回答' })
  })

  it('assistant 无 sections 时 answer 回退 m.content', () => {
    const items = roundNavItems([
      user('问'),
      { id: 'msg_a', role: 'assistant', content: '纯文本回答', timestamp: 2000 },
    ])
    expect(items[0].answer).toBe('纯文本回答')
  })

  it('totalDuration：包络公式（run_started_at 优先），无则省略', () => {
    const items = roundNavItems([
      user('问'),
      assistant(
        [reasonSection(1000), { type: 'content', content: '答', timestamp: 3000, duration: 0 }],
        {
          meta: { run_started_at: 0 + 800 },
        }
      ),
      user('第二问', 5000),
      // 无 sections 的 assistant → 无总耗时
      { id: 'msg_a2', role: 'assistant', content: 'x', timestamp: 6000 },
    ])
    expect(items[0].totalDuration).toBe('2s') // 3000 − 800 = 2.2s，展示取整
    expect(items[1].totalDuration).toBeUndefined()
  })

  it('toolCount：tool_group + reason 内嵌 tool 合计；0 则省略', () => {
    const items = roundNavItems([
      user('问'),
      assistant([
        {
          type: 'reason',
          items: [{ itemType: 'tool', tool: { callId: 'c1', name: 'a', status: 'success' } }],
          timestamp: 1000,
        },
        {
          type: 'tool_group',
          tools: [
            { callId: 'c2', name: 'b', status: 'success' },
            { callId: 'c3', name: 'c', status: 'failed' },
          ],
          timestamp: 1500,
        },
        { type: 'content', content: '答', timestamp: 2000 },
      ]),
      user('第二问', 5000),
      assistant([{ type: 'content', content: '答', timestamp: 6000 }]),
    ])
    expect(items[0].toolCount).toBe(3)
    expect(items[1].toolCount).toBeUndefined()
  })

  it('流式中刚发出的 user 消息（后无 assistant）：answer/耗时/工具数全省略', () => {
    const items = roundNavItems([
      user('第一问'),
      assistant([{ type: 'content', content: '答', timestamp: 2000 }]),
      user('刚发出的问题', 9000),
    ])
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual({ messageId: 'msg_9000', question: '刚发出的问题' })
  })

  it('空消息列表 → 空数组', () => {
    expect(roundNavItems([])).toEqual([])
  })
})
