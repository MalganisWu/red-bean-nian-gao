import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Button } from '../Button'
import { Input } from '../Input'

describe('Design System 基础交互契约', () => {
  it('Button 转发点击和禁用语义', () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>继续</Button>)

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(
      <Button disabled onClick={onClick}>
        继续
      </Button>
    )
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('Input 保留标签、输入和禁用状态', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Input aria-label="任务名称" onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: '任务名称' })

    fireEvent.change(input, { target: { value: '每日总结' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('每日总结')

    rerender(<Input aria-label="任务名称" disabled />)
    expect(screen.getByRole('textbox', { name: '任务名称' })).toBeDisabled()
  })
})
