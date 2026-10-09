import { describe, it, expect } from 'vitest'
import { findLastCardSectionIndex, findCardMergeTarget, mergeContinuation } from '../card-merge'
import type { DisplayMessage, MessageSection } from '@/types/chat'

function card(status: 'pending' | 'answered' | 'refused', id = 'call_1'): MessageSection {
  return {
    type: 'card',
    card: {
      interaction_id: id,
      status,
      questions: [{ id: 'q1', text: '确认？', options: ['是', '否'] }],
      answers: null,
    },
    timestamp: 0,
  }
}
function content(text: string): MessageSection {
  return { type: 'content', content: text, timestamp: 0 }
}

describe('findLastCardSectionIndex', () => {
  it('找到最后一张非 pending 卡片', () => {
    const sections = [content('a'), card('answered'), content('b')]
    expect(findLastCardSectionIndex(sections)).toBe(1)
  })

  it('pending 卡片也是 answer 流的原地合并目标', () => {
    expect(findLastCardSectionIndex([card('pending')])).toBe(0)
  })

  it('无卡片返回 -1', () => {
    expect(findLastCardSectionIndex([content('a')])).toBe(-1)
  })

  it('多个卡片取最后一张', () => {
    const sections = [card('answered', 'call_1'), content('b'), card('refused', 'call_2')]
    expect(findLastCardSectionIndex(sections)).toBe(2)
  })
})

describe('findCardMergeTarget', () => {
  it('最后一条含非 pending 卡片的消息是合并目标', () => {
    const messages: DisplayMessage[] = [
      { id: 'u', role: 'user', content: 'hi', timestamp: 0 },
      { id: 'a', role: 'assistant', sections: [content('提问'), card('answered')], timestamp: 0 },
    ]
    expect(findCardMergeTarget(messages)).toBe(1)
  })

  it('pending 卡片所在的最后一条消息可接收 answer 续跑', () => {
    expect(
      findCardMergeTarget([
        { id: 'u', role: 'user', content: 'hi', timestamp: 0 },
        { id: 'a', role: 'assistant', sections: [card('pending')], timestamp: 0 },
      ])
    ).toBe(1)
  })

  it('无卡片时返回 -1', () => {
    expect(
      findCardMergeTarget([
        { id: 'a', role: 'assistant', sections: [content('新回复')], timestamp: 0 },
      ])
    ).toBe(-1)
  })

  it('交互后的普通新消息（最后一条无卡片）不命中', () => {
    const messages: DisplayMessage[] = [
      { id: 'a', role: 'assistant', sections: [card('answered')], timestamp: 0 },
      { id: 'u', role: 'user', content: '再来', timestamp: 0 },
      { id: 'a2', role: 'assistant', sections: [content('新回复')], timestamp: 0 },
    ]
    expect(findCardMergeTarget(messages)).toBe(-1)
  })
})

describe('mergeContinuation', () => {
  it('把续跑 sections 插到最后一张卡片之后，保留卡片前的提问与卡片后的旧内容', () => {
    const sections = [content('提问'), card('answered'), content('旧答复')]
    expect(mergeContinuation(sections, [content('续跑')])).toEqual([
      content('提问'),
      card('answered'),
      content('续跑'),
      content('旧答复'),
    ])
  })

  it('pending 卡片同样作为原地合并目标（answer 未确认前）', () => {
    expect(mergeContinuation([card('pending')], [content('回答')])).toEqual([
      card('pending'),
      content('回答'),
    ])
  })

  it('多卡片时只取最后一张作为插入点，二次提问的新卡片位于续跑之前', () => {
    const sections = [card('answered', 'call_1'), content('b'), card('pending', 'call_2')]
    expect(mergeContinuation(sections, [content('续跑')])).toEqual([
      card('answered', 'call_1'),
      content('b'),
      card('pending', 'call_2'),
      content('续跑'),
    ])
  })

  it('无卡片时追加到尾部（防御性行为，调用点不会出现）', () => {
    expect(mergeContinuation([content('a')], [content('b')])).toEqual([content('a'), content('b')])
  })

  it('纯函数：不修改入参', () => {
    const sections = [content('提问'), card('answered')]
    const continuation = [content('续跑')]
    mergeContinuation(sections, continuation)
    expect(sections).toHaveLength(2)
    expect(continuation).toHaveLength(1)
  })
})
