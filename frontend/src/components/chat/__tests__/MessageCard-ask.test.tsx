import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { QuestionCardProps } from '@/components/retroui/QuestionCard'
import type { MessageSection } from '@/types/chat'

// Mock QuestionCard：断言 MessageCard 传给它的 props。
const mocks = vi.hoisted(() => ({ onConfirm: vi.fn(), onRefuse: vi.fn() }))

vi.mock('@/components/retroui/QuestionCard', () => ({
  QuestionCard: (props: QuestionCardProps) => (
    <div
      data-testid="question-card"
      data-status={props.status}
      data-submitting={String(props.submitting ?? false)}
      data-disabled={String(props.disabled ?? false)}
      data-error={props.error}
    >
      <button
        onClick={() => {
          mocks.onConfirm(props)
          props.onConfirm?.({ q1: { kind: 'option' as const, value: '确认删除' } })
        }}
      >
        confirm
      </button>
      <button
        onClick={() => {
          mocks.onRefuse(props)
          props.onRefuse?.()
        }}
      >
        refuse
      </button>
    </div>
  ),
}))

import { MessageCard } from '@/components/chat/MessageCard'

function cardSection(status: 'pending' | 'answered' | 'refused'): MessageSection {
  return {
    type: 'card',
    card: {
      interaction_id: 'call_1',
      status,
      questions: [
        { id: 'q1', text: '确认删除？', options: ['确认删除', '取消'], select: 'single' },
      ],
      answers: status === 'answered' ? { q1: { kind: 'option', value: '确认删除' } } : null,
    },
    timestamp: 0,
  }
}

describe('MessageCard 询问卡片 section 渲染', () => {
  beforeEach(() => {
    mocks.onConfirm.mockClear()
    mocks.onRefuse.mockClear()
  })

  it('pending 卡片保持受控 pending，且挂确认/拒绝回调', () => {
    render(
      <MessageCard
        sections={[cardSection('pending')]}
        onCardConfirm={mocks.onConfirm}
        onCardRefuse={mocks.onRefuse}
      />
    )
    const qc = screen.getByTestId('question-card')
    expect(qc).toHaveAttribute('data-status', 'pending')
  })

  it('answered 卡片 section 传 status="answered" + answers（只读回显）', () => {
    render(<MessageCard sections={[cardSection('answered')]} />)
    fireEvent.click(screen.getByRole('button', { name: /过程已完成/ }))
    const qc = screen.getByTestId('question-card')
    expect(qc.getAttribute('data-status')).toBe('answered')
  })

  it('pending 卡片确认/拒绝触发上层回调（带 interaction_id）', () => {
    render(
      <MessageCard
        sections={[cardSection('pending')]}
        onCardConfirm={mocks.onConfirm}
        onCardRefuse={mocks.onRefuse}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    // 第一参为 interaction_id，第二参为答案
    expect(mocks.onConfirm).toHaveBeenCalledWith('call_1', {
      q1: { kind: 'option', value: '确认删除' },
    })
  })

  it('提交中与失败状态原位传给 pending 卡片', () => {
    const { rerender } = render(
      <MessageCard
        sections={[cardSection('pending')]}
        cardSubmission={{
          interactionId: 'call_1',
          state: 'submitting',
          answers: { q1: { kind: 'option', value: '确认删除' } },
        }}
      />
    )
    expect(screen.getByTestId('question-card')).toHaveAttribute('data-disabled', 'false')
    expect(screen.getByTestId('question-card')).toHaveAttribute('data-submitting', 'true')

    rerender(
      <MessageCard
        sections={[cardSection('pending')]}
        cardSubmission={{
          interactionId: 'call_1',
          state: 'error',
          answers: { q1: { kind: 'option', value: '确认删除' } },
          error: '提交未完成，请重试。',
        }}
      />
    )
    expect(screen.getByTestId('question-card')).toHaveAttribute(
      'data-error',
      '提交未完成，请重试。'
    )
  })

  it('START 接受回答后立即在原节点显示 answered', () => {
    render(
      <MessageCard
        sections={[cardSection('pending')]}
        isStreaming
        cardSubmission={{
          interactionId: 'call_1',
          state: 'accepted',
          answers: { q1: { kind: 'option', value: '确认删除' } },
        }}
      />
    )
    expect(screen.getByTestId('question-card')).toHaveAttribute('data-status', 'answered')
    expect(screen.getByText('正在执行')).toBeInTheDocument()
  })

  it('当前流 DONE 前锁定后续 pending 卡片，避免二次回答抢跑', () => {
    render(
      <MessageCard
        sections={[cardSection('pending')]}
        isStreaming
        cardSubmission={{
          interactionId: 'call_previous',
          state: 'accepted',
          answers: { q1: { kind: 'option', value: '继续' } },
        }}
        onCardConfirm={mocks.onConfirm}
        onCardRefuse={mocks.onRefuse}
      />
    )

    expect(screen.getByTestId('question-card')).toHaveAttribute('data-disabled', 'true')
    expect(screen.getByTestId('question-card')).toHaveAttribute('data-submitting', 'false')
  })
})
