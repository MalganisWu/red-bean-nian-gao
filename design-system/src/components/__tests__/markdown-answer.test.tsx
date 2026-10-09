import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownAnswer } from '../MarkdownAnswer'

const SOURCE = `普通正文直接进入阅读流。

## 结构化内容

- 第一项
- 第二项

\`\`\`text
# 标题
- 列表
**重点**
\`\`\``

describe('MarkdownAnswer', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('最终回答裸排 Markdown，不给整篇内容添加卡片外框或复制按钮', () => {
    render(<MarkdownAnswer content={SOURCE} />)

    const answer = screen.getByRole('article', { name: 'Markdown 回答' })
    expect(answer).not.toHaveClass('rounded-xl', 'border', 'px-5')
    expect(screen.getByRole('heading', { name: '结构化内容' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制 Markdown 原文' })).not.toBeInTheDocument()
  })

  it('代码围栏独立显示语言标签并复制原始代码', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<MarkdownAnswer content={SOURCE} />)
    expect(screen.getByRole('region', { name: '纯文本代码块' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '复制纯文本代码' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# 标题\n- 列表\n**重点**'))
    expect(screen.getByRole('button', { name: '纯文本代码已复制' })).toHaveClass('text-success')
  })

  it('非安全 HTTP 环境回退到原生 copy 命令', async () => {
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    render(<MarkdownAnswer content={SOURCE} />)
    fireEvent.click(screen.getByRole('button', { name: '复制纯文本代码' }))

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(screen.getByRole('button', { name: '纯文本代码已复制' })).toBeInTheDocument()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('代码复制失败时原位给出明确反馈', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
    })

    render(<MarkdownAnswer content={SOURCE} />)
    fireEvent.click(screen.getByRole('button', { name: '复制纯文本代码' }))

    expect(await screen.findByRole('button', { name: '纯文本代码复制失败，请重试' })).toHaveClass(
      'text-danger'
    )
  })
})
