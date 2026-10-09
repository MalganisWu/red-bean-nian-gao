import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RoundNav, type RoundNavEntry } from '@/components/retroui/RoundNav'

const entry = (id: string, withPreview = true): RoundNavEntry => ({
  id,
  preview: withPreview ? <div>摘要 {id}</div> : undefined,
})

describe('RoundNav 边沟横杠导航', () => {
  it('横杠数 = entries 数', () => {
    render(<RoundNav entries={[entry('a'), entry('b'), entry('c')]} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('点击横杠 → onSelect 带 id', () => {
    const onSelect = vi.fn()
    render(<RoundNav entries={[entry('a'), entry('b')]} onSelect={onSelect} />)
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('悬停有 preview 的条目出摘要卡，移开消失', () => {
    render(<RoundNav entries={[entry('a')]} />)
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(screen.getByTestId('round-nav-preview')).toHaveTextContent('摘要 a')
    fireEvent.mouseLeave(screen.getByRole('button'))
    expect(screen.queryByTestId('round-nav-preview')).not.toBeInTheDocument()
  })

  it('无 preview 的条目悬停不出卡', () => {
    render(<RoundNav entries={[entry('bare', false)]} />)
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(screen.queryByTestId('round-nav-preview')).not.toBeInTheDocument()
  })

  it('currentId 条目在静止时保留豆沙红标记', () => {
    const { container } = render(<RoundNav entries={[entry('a'), entry('b')]} currentId="b" />)
    const dashes = container.querySelectorAll('button > span')
    expect(dashes[1]).toHaveStyle({ width: '21px' })
    expect(dashes[1].className).toContain('bg-brand-indicator')
    expect(dashes[0]).toHaveStyle({ width: '10px' })
    expect(dashes[0].className).toContain('bg-round-nav-marker')
  })

  it('悬停形成以指针轮次为峰值、向两侧递减的连续波峰', () => {
    const { container } = render(
      <RoundNav
        entries={[entry('a'), entry('b'), entry('c'), entry('d'), entry('e')]}
        currentId="a"
      />
    )
    const buttons = screen.getAllByRole('button')
    fireEvent.mouseEnter(buttons[2])

    const dashes = container.querySelectorAll<HTMLElement>('button > span')
    const widths = [...dashes].map((dash) => Number.parseFloat(dash.style.width))
    expect(widths[2]).toBe(42)
    expect(widths[1]).toBeGreaterThan(widths[0])
    expect(widths[3]).toBeGreaterThan(widths[4])
    expect(dashes[2].className).toContain('bg-foreground')
    expect(dashes[0].className).toContain('bg-round-nav-marker')
    expect(dashes[0].className).not.toContain('bg-brand-indicator')
  })
})
