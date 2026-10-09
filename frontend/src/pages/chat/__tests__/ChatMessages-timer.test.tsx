import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ChatMessages } from '@/pages/chat/ChatMessages'
import type { DisplayMessage, MessageSection } from '@/types/chat'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function timerText(el: HTMLElement): string {
  return el.textContent ?? ''
}

describe('ChatMessages 占位符发送即计时', () => {
  it('轮次导航位于正文左侧，并用右侧等宽占位保持正文中轴', () => {
    const sentAt = Date.now()
    const { container } = render(
      <ChatMessages
        messages={[
          { id: 'u1', role: 'user', content: '第一轮', timestamp: sentAt },
          { id: 'a1', role: 'assistant', content: '回答', timestamp: sentAt + 1 },
        ]}
        isStreaming={false}
        streamingStartedAt={0}
        sentAt={0}
        error={null}
        onDismissError={() => {}}
      />
    )

    const navButton = screen.getByRole('button', { name: '跳转到第 1 轮' })
    const leftRail = navButton.parentElement?.parentElement
    const scrollPane = leftRail?.nextElementSibling
    const balanceSpacer = scrollPane?.nextElementSibling

    expect(leftRail).toHaveClass('w-14')
    expect(scrollPane).toHaveClass('overflow-y-auto')
    expect(balanceSpacer).toHaveAttribute('aria-hidden', 'true')
    expect(balanceSpacer).toHaveClass('w-14')
    expect(container.firstElementChild?.firstElementChild).toBe(leftRail)
  })

  it('确认已接受但续跑内容未到时，原 Process 立即恢复执行且不另起占位符', () => {
    const sentAt = Date.now()
    const assistant: DisplayMessage = {
      id: 'a1',
      role: 'assistant',
      timestamp: sentAt - 1000,
      sections: [
        {
          type: 'process',
          timestamp: sentAt - 1000,
          steps: [
            { kind: 'think', content: '先确认执行范围。' },
            {
              kind: 'approval',
              approval: {
                interaction_id: 'ask-1',
                status: 'pending',
                questions: [
                  {
                    id: 'scope',
                    text: '继续执行吗？',
                    options: ['继续'],
                    select: 'single',
                  },
                ],
              },
            },
          ],
        },
        {
          type: 'card',
          timestamp: sentAt - 500,
          card: {
            interaction_id: 'ask-1',
            status: 'pending',
            questions: [
              {
                id: 'scope',
                text: '继续执行吗？',
                options: ['继续'],
                select: 'single',
              },
            ],
          },
        },
      ],
    }

    render(
      <ChatMessages
        messages={[assistant]}
        isStreaming
        streamingStartedAt={sentAt}
        sentAt={sentAt}
        error={null}
        onDismissError={() => {}}
        pendingSections={[]}
        cardSubmission={{
          interactionId: 'ask-1',
          state: 'accepted',
          answers: { scope: { kind: 'option', value: '继续' } },
        }}
      />
    )

    expect(screen.getByRole('button', { name: /正在执行/ })).toBeInTheDocument()
    expect(screen.queryByText('正在处理…')).not.toBeInTheDocument()
    expect(screen.getByText('你的回答')).toBeInTheDocument()
  })

  it('发送后无响应窗口：sentAt>0 时占位符从发送瞬间开始跑秒', () => {
    const sentAt = Date.now()
    const user: DisplayMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: sentAt,
    }
    const { container } = render(
      <ChatMessages
        messages={[user]}
        isStreaming
        streamingStartedAt={0}
        sentAt={sentAt}
        error={null}
        onDismissError={() => {}}
        pendingSections={[]}
      />
    )

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('正在处理…')
    // 首帧不足一秒时稳定显示为 1s，不出现小数跳动。
    expect(status).toHaveTextContent('1s')

    // 每秒刷新一次，持续显示整数秒。
    act(() => {
      vi.advanceTimersByTime(31000)
    })
    const text = timerText(status)
    expect(text).toMatch(/\d+s/)
    expect(text).not.toMatch(/\d+\.\d+s/)
    // container 快照（补充断言，避免 DOM 树里其它文本干扰 toHaveTextContent）
    expect(container.textContent).toMatch(/正在处理…\s*·\s*\d+s/)
  })

  it('首个 STATUS 的空 reason（无步）不算有内容：占位符不被顶掉，持续按发送锚点跑秒', () => {
    const sentAt = Date.now()
    const user: DisplayMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: sentAt,
    }
    const emptyReason: MessageSection = {
      type: 'reason',
      items: [],
      timestamp: 0,
    }
    const { container } = render(
      <ChatMessages
        messages={[user]}
        isStreaming
        streamingStartedAt={0}
        sentAt={sentAt}
        error={null}
        onDismissError={() => {}}
        pendingSections={[emptyReason]}
      />
    )

    // 空 reason 不会产出折叠块 —— 占位符仍在（不被顶掉）；首帧最低显示 1s。
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('正在处理…')
    expect(status).toHaveTextContent('1s')

    // 推 31s：耗时从发送锚点增长且保持整数秒。
    act(() => {
      vi.advanceTimersByTime(31000)
    })
    const text = container.textContent ?? ''
    expect(text).toContain('正在处理…')
    expect(text).toMatch(/·\s*\d+s/)
    expect(text).not.toMatch(/\d+\.\d+s/)
  })

  it('reason 一旦有步（首条内容到达）：占位符让位给折叠块', () => {
    const sentAt = Date.now()
    const user: DisplayMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: sentAt,
    }
    const reasonFull: MessageSection = {
      type: 'reason',
      items: [{ itemType: 'step', index: 1, content: '开始思考' }],
      timestamp: sentAt,
    }
    render(
      <ChatMessages
        messages={[user]}
        isStreaming
        streamingStartedAt={0}
        sentAt={sentAt}
        error={null}
        onDismissError={() => {}}
        pendingSections={[reasonFull]}
      />
    )

    // 有步 → hasStreaming 为真 → 外部“正在处理…”占位符不再出现。
    // Process 自身保留 role=status，用于向辅助技术播报运行状态。
    expect(screen.queryByText(/^正在处理…/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在执行')
  })

  it('sentAt=0（旧会话/未打点）时占位符不显示计时数字，仅思考文案', () => {
    const user: DisplayMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 0,
    }
    render(
      <ChatMessages
        messages={[user]}
        isStreaming
        streamingStartedAt={0}
        sentAt={0}
        error={null}
        onDismissError={() => {}}
        pendingSections={[]}
      />
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('正在处理…')
    expect(status).not.toHaveTextContent('·')
  })
})
