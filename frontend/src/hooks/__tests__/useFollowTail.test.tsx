import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

import { FOLLOW_TAIL_THRESHOLD_PX, useFollowTail } from '../useFollowTail'

/** 测试挂载点：把 hook 接到一个带 onScroll 的滚动容器上。 */
function FollowHarness({ active, contentKey }: { active: boolean; contentKey: number }) {
  const { containerRef, onScroll } = useFollowTail({ active, contentKey })
  return (
    <div ref={containerRef} onScroll={onScroll} data-testid="scroller">
      <span>{`chunk-${contentKey}`}</span>
    </div>
  )
}

interface ScrollBox {
  scrollTop: number
  scrollHeight: number
}

/**
 * jsdom 没有布局引擎：把滚动几何做成元素实例上的可变属性，
 * 测试按需驱动 scrollHeight（模拟内容增长）与 scrollTop（模拟用户滚动）。
 */
function bindScrollGeometry(el: HTMLElement, clientHeight: number): ScrollBox {
  const box: ScrollBox = { scrollTop: 0, scrollHeight: 0 }
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => box.scrollTop,
    set: (value: number) => {
      box.scrollTop = value
    },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  return box
}

/** 距底距离 = scrollHeight - scrollTop - clientHeight。 */
function distanceToBottom(box: ScrollBox, clientHeight: number): number {
  return box.scrollHeight - box.scrollTop - clientHeight
}

describe('useFollowTail：流式跟随尾部', () => {
  it('live 且处于跟随中：内容增长自动贴底', () => {
    const { rerender, getByTestId } = render(<FollowHarness active contentKey={1} />)
    const el = getByTestId('scroller')
    const box = bindScrollGeometry(el, 200)

    box.scrollHeight = 600
    rerender(<FollowHarness active contentKey={2} />)
    expect(el.scrollTop).toBe(600)

    box.scrollHeight = 900
    rerender(<FollowHarness active contentKey={3} />)
    expect(el.scrollTop).toBe(900)
  })

  it('用户上滚（距底超过阈值）暂停跟随：内容继续增长不强制贴底', () => {
    const { rerender, getByTestId } = render(<FollowHarness active contentKey={1} />)
    const el = getByTestId('scroller')
    const box = bindScrollGeometry(el, 200)

    box.scrollHeight = 600
    rerender(<FollowHarness active contentKey={2} />)
    expect(el.scrollTop).toBe(600)

    // 用户上滚：距底 280px > 阈值 → 暂停
    box.scrollTop = 120
    fireEvent.scroll(el)
    expect(distanceToBottom(box, 200)).toBeGreaterThan(FOLLOW_TAIL_THRESHOLD_PX)

    box.scrollHeight = 900
    rerender(<FollowHarness active contentKey={3} />)
    expect(el.scrollTop).toBe(120)
  })

  it('阈值边界：距底恰好 40px 仍视为在底部继续跟随，41px 视为上滚暂停', () => {
    const { rerender, getByTestId } = render(<FollowHarness active contentKey={1} />)
    const el = getByTestId('scroller')
    const box = bindScrollGeometry(el, 200)

    // 距底 = 600 - 360 - 200 = 40 → 不暂停
    box.scrollHeight = 600
    box.scrollTop = 600 - 200 - FOLLOW_TAIL_THRESHOLD_PX
    fireEvent.scroll(el)
    box.scrollHeight = 800
    rerender(<FollowHarness active contentKey={2} />)
    expect(el.scrollTop).toBe(800)

    // 距底 = 800 - 559 - 200 = 41 → 暂停
    box.scrollTop = 800 - 200 - (FOLLOW_TAIL_THRESHOLD_PX + 1)
    fireEvent.scroll(el)
    box.scrollHeight = 1000
    rerender(<FollowHarness active contentKey={3} />)
    expect(el.scrollTop).toBe(559)
  })

  it('回到底部阈值内：自动恢复跟随', () => {
    const { rerender, getByTestId } = render(<FollowHarness active contentKey={1} />)
    const el = getByTestId('scroller')
    const box = bindScrollGeometry(el, 200)

    // 先上滚进入暂停态
    box.scrollHeight = 600
    box.scrollTop = 120
    fireEvent.scroll(el)
    box.scrollHeight = 900
    rerender(<FollowHarness active contentKey={2} />)
    expect(el.scrollTop).toBe(120)

    // 用户滚回距底 30px（阈值内）→ 恢复；内容再增长时重新贴底
    box.scrollTop = 900 - 200 - 30
    fireEvent.scroll(el)
    box.scrollHeight = 1200
    rerender(<FollowHarness active contentKey={3} />)
    expect(el.scrollTop).toBe(1200)
  })

  it('非 live（active=false）不自动滚：历史回放由用户自由浏览', () => {
    const { rerender, getByTestId } = render(<FollowHarness active={false} contentKey={1} />)
    const el = getByTestId('scroller')
    const box = bindScrollGeometry(el, 200)

    box.scrollTop = 50
    box.scrollHeight = 600
    rerender(<FollowHarness active={false} contentKey={2} />)
    expect(el.scrollTop).toBe(50)
  })

  it('跟随窗口关闭再开启：重置为跟随，新一轮流式从贴底开始', () => {
    const { rerender, getByTestId } = render(<FollowHarness active contentKey={1} />)
    const el = getByTestId('scroller')
    const box = bindScrollGeometry(el, 200)

    // 第一轮流中用户上滚暂停
    box.scrollHeight = 600
    rerender(<FollowHarness active contentKey={2} />)
    box.scrollTop = 120
    fireEvent.scroll(el)
    box.scrollHeight = 900
    rerender(<FollowHarness active contentKey={3} />)
    expect(el.scrollTop).toBe(120)

    // 流结束（isLive 翻假）→ 跟随意图复位；新一轮内容增长重新贴底
    rerender(<FollowHarness active={false} contentKey={3} />)
    rerender(<FollowHarness active contentKey={4} />)
    expect(el.scrollTop).toBe(900)
  })
})
