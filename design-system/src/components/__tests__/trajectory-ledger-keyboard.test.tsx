import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TrajectoryLedger } from '../TrajectoryLedger'
import type { TrajectoryTurn } from '../trajectoryTypes'

// 本仓 vitest 未开 `globals`，Testing Library 的自动 cleanup 不会注册；不显式清理的话，
// 上一个用例的 DOM 会留在 body 里，`screen.*` 从第二个用例起就会查到重复元素。
afterEach(cleanup)

/**
 * 键盘激活验收：鼠标能做的事，键盘都能做。
 *
 * 产出行与摘要行都是 `div role="button"` —— `role` 只**声明**语义、`tabIndex` 只让它能获得焦点，
 * 两者都不附带任何行为。它们此前只有 `onClick`，于是键盘用户能聚焦、看得见焦点环，按下
 * Enter/Space 却什么都不发生。这里锁住「键盘激活与点击等价」。
 */

const TURNS: TrajectoryTurn[] = [
  {
    turn: 1,
    startedAt: '14:00:00',
    durationMs: 1200,
    tokens: 100,
    records: [
      { id: 'u1', kind: 'user', at: '14:00:00', summary: '你好' },
      {
        id: 'c1',
        kind: 'call',
        at: '14:00:01',
        summary: '回复',
        thinking: '想想',
        reply: '好的',
      },
      { id: 't1', kind: 'tool', at: '14:00:02', summary: '读文件', name: 'read_file' },
    ],
  },
]

/** 文本所在的可聚焦容器；`role="button"` 是这些行的共同锚点。 */
function focusableRow(label: string): HTMLElement {
  const el = screen.getByText(label).closest('[role="button"]')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

describe('TrajectoryLedger 的键盘激活', () => {
  it('Enter 与点击等价，且带上所属 tab', () => {
    const onSelect = vi.fn()
    render(<TrajectoryLedger turns={TURNS} onSelect={onSelect} />)

    fireEvent.keyDown(focusableRow('想想'), { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('c1', '思考')
  })

  it('Space 与点击等价', () => {
    const onSelect = vi.fn()
    render(<TrajectoryLedger turns={TURNS} onSelect={onSelect} />)

    fireEvent.keyDown(focusableRow('好的'), { key: ' ' })

    expect(onSelect).toHaveBeenCalledWith('c1', '正文')
  })

  it('无关按键不触发选中', () => {
    const onSelect = vi.fn()
    render(<TrajectoryLedger turns={TURNS} onSelect={onSelect} />)

    fireEvent.keyDown(focusableRow('想想'), { key: 'a' })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('每个可聚焦行都是可键盘操作的：都能获得焦点', () => {
    const { container } = render(<TrajectoryLedger turns={TURNS} onSelect={vi.fn()} />)

    const rows = container.querySelectorAll<HTMLElement>('[role="button"]')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.getAttribute('tabindex')).toBe('0')
    }
  })

  it('折叠摘要行：Enter 展开该层，收起态随之减少', () => {
    render(<TrajectoryLedger turns={TURNS} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /折叠全部/ }))
    const collapsedBefore = document.querySelectorAll('[role="button"][aria-expanded="false"]')
    expect(collapsedBefore.length).toBeGreaterThan(0)

    const summary = collapsedBefore[0] as HTMLElement
    fireEvent.keyDown(summary, { key: 'Enter' })

    expect(document.querySelectorAll('[role="button"][aria-expanded="false"]').length).toBeLessThan(
      collapsedBefore.length
    )
  })
})
