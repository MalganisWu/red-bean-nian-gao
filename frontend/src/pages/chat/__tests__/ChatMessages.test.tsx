import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatMessages } from '@/pages/chat/ChatMessages'
import type { DisplayMessage } from '@/types/chat'

// jsdom 无 scrollIntoView
const scrollIntoView = vi.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

const round = (i: number): DisplayMessage[] => [
  { id: `msg_u${i}`, role: 'user', content: `第 ${i} 问`, timestamp: i * 1000 },
  {
    id: `msg_a${i}`,
    role: 'assistant',
    sections: [{ type: 'content', content: `第 ${i} 答`, timestamp: i * 1000 + 500 }],
    timestamp: i * 1000 + 500,
  },
]

const baseProps = {
  isStreaming: false,
  streamingStartedAt: 0,
  sentAt: 0,
  error: null,
  onDismissError: () => {},
}

describe('ChatMessages 轮次导航集成', () => {
  it('边沟横杠数 = 用户消息轮数', () => {
    render(<ChatMessages {...baseProps} messages={[...round(1), ...round(2), ...round(3)]} />)
    expect(screen.getAllByRole('button', { name: /跳转到第 \d+ 轮/ })).toHaveLength(3)
  })

  it('点击横杠：scrollIntoView 平滑跳转 + 目标消息加 round-flash', () => {
    render(<ChatMessages {...baseProps} messages={[...round(1), ...round(2)]} />)
    fireEvent.click(screen.getAllByRole('button', { name: /跳转到第 \d+ 轮/ })[1])
    const target = document.getElementById('msg_u2')
    if (!target) throw new Error('目标消息未渲染')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(target.className).toContain('round-flash')
  })

  it('悬停横杠出摘要卡（含 Q 与 A 截断文本）', () => {
    render(<ChatMessages {...baseProps} messages={round(1)} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: /跳转到第 \d+ 轮/ }))
    const card = screen.getByTestId('round-nav-preview')
    expect(card).toHaveTextContent('第 1 问')
    expect(card).toHaveTextContent('第 1 答')
    expect(card).toHaveTextContent('第 1 轮')
  })

  it('流式中追加 user 消息 → 横杠实时 +1', () => {
    const { rerender } = render(<ChatMessages {...baseProps} messages={round(1)} />)
    expect(screen.getAllByRole('button', { name: /跳转到第 \d+ 轮/ })).toHaveLength(1)
    rerender(<ChatMessages {...baseProps} messages={[...round(1), ...round(2)]} isStreaming />)
    expect(screen.getAllByRole('button', { name: /跳转到第 \d+ 轮/ })).toHaveLength(2)
  })

  it('空会话：无横杠，不报错', () => {
    render(<ChatMessages {...baseProps} messages={[]} />)
    expect(screen.queryByRole('button', { name: /跳转到第 \d+ 轮/ })).not.toBeInTheDocument()
  })
})
