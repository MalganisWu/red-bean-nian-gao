import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownAnswer } from '@/components/retroui/MarkdownAnswer'

const SOURCE = '普通正文。\n\n## 标题\n\n```text\n# 原始标题\n```'

describe('MarkdownAnswer 前端集成', () => {
  it('消费裸排最终回答和独立代码块操作', () => {
    render(<MarkdownAnswer content={SOURCE} />)

    expect(screen.getByRole('article', { name: 'Markdown 回答' })).not.toHaveClass(
      'rounded-xl',
      'border'
    )
    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '纯文本代码块' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制纯文本代码' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制 Markdown 原文' })).not.toBeInTheDocument()
  })
})
