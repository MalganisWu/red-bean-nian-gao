import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProcessFold } from '@/components/retroui/ProcessFold'
import type { ProcessStep } from '@/components/retroui/ProcessFold'

const thinkStep: ProcessStep = { kind: 'think', content: '想一想' }
const toolStep: ProcessStep = {
  kind: 'tool',
  tool: { callId: 'c1', name: 'calc', status: 'success', duration: '1.2s', result: '42' },
}

describe('ProcessFold 思考过程折叠区', () => {
  function processButton(name: string): HTMLButtonElement {
    const button = screen.getByText(name).closest('button')
    if (!button) throw new Error(`Process 按钮未渲染：${name}`)
    return button
  }

  it('默认收拢：只有标签行，步骤不可见', () => {
    render(<ProcessFold steps={[thinkStep, toolStep]} totalDuration="3.9s" />)
    expect(screen.getByText('过程已完成')).toBeInTheDocument()
    expect(screen.getByText('2 步 · 3.9s')).toBeInTheDocument()
    expect(screen.getByText('过程已完成').closest('button')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('点击标签展开/收拢（用户覆盖优先）', () => {
    render(<ProcessFold steps={[thinkStep]} />)
    const head = processButton('过程已完成')
    expect(head).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
  })

  it('流式中默认展开，可手动收拢', () => {
    render(<ProcessFold steps={[thinkStep]} isStreaming />)
    const head = processButton('正在执行')
    expect(head).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
  })

  it('展开时只显示连续轨道，不显示类型标签或步骤编号', () => {
    render(<ProcessFold steps={[thinkStep, toolStep]} defaultExpanded />)
    expect(screen.getByText('想一想')).toBeInTheDocument()
    expect(screen.queryByText('01')).not.toBeInTheDocument()
    expect(screen.queryByText('思考')).not.toBeInTheDocument()
  })

  it('空步骤不渲染', () => {
    const { container } = render(<ProcessFold steps={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('无总耗时不显示耗时文本', () => {
    render(<ProcessFold steps={[thinkStep]} />)
    expect(screen.queryByText(/\d+\.\ds/)).not.toBeInTheDocument()
  })

  it('等待确认时即使收起过程，approval 仍然可见', () => {
    render(
      <ProcessFold
        status="awaiting"
        steps={[
          thinkStep,
          {
            kind: 'approval',
            state: 'waiting',
            approval: <button type="button">确认并继续</button>,
          },
        ]}
      />
    )
    const head = processButton('等待确认')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: '确认并继续' })).toBeVisible()
  })

  it('运行中的展开状态在完成后保持，不让回答与续跑步骤突然消失', () => {
    const { rerender } = render(<ProcessFold status="awaiting" steps={[thinkStep]} />)

    expect(screen.getByRole('button', { name: /等待确认/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    rerender(<ProcessFold status="completed" steps={[thinkStep, toolStep]} />)

    expect(screen.getByRole('button', { name: /过程已完成/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('想一想')).toBeVisible()
  })
})
