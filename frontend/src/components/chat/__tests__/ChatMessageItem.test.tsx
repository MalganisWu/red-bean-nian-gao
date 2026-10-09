import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ChatMessageItem } from '@/pages/chat/ChatMessageItem'

describe('ChatMessageItem 用户消息', () => {
  it('使用 8px 对称圆角且不显示无语义品牌色圆点', () => {
    const { container } = render(
      <ChatMessageItem
        message={{
          id: 'user-1',
          role: 'user',
          content: '检查订单同步失败的原因',
          timestamp: Date.parse('2026-08-31T10:00:00+08:00'),
        }}
      />
    )

    expect(screen.getByText('检查订单同步失败的原因')).toHaveClass('w-fit', 'rounded-lg')
    expect(container.querySelector('.bg-primary')).not.toBeInTheDocument()
  })
})
