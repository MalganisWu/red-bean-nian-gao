import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { trapTabFocus } from '../focus-trap'

// jsdom 不参与布局：getClientRects 恒为空数组会导致「可见性过滤」清空候选，
// stub 为返回非空 rect 以通过过滤（真实浏览器中该 API 返回真实布局矩形）。
function stubVisible(): void {
  Object.defineProperty(HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 10, height: 10 }] as unknown as DOMRectList,
  })
}

function tabEvent(shiftKey: boolean): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true })
}

function setupContainer(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

describe('trapTabFocus 抽屉焦点陷阱', () => {
  beforeEach(() => stubVisible())

  afterEach(() => {
    document.body.innerHTML = ''
    ;(document.body as HTMLBodyElement).focus()
  })

  it('焦点在末位元素按 Tab → 回绕到首位并阻止默认', () => {
    const container = setupContainer('<button>1</button><button>2</button><button>3</button>')
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('button'))
    buttons[2]?.focus()

    const event = tabEvent(false)
    trapTabFocus(event, container)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(buttons[0])
  })

  it('焦点在容器外按 Tab → 拉回首位', () => {
    const container = setupContainer('<button>1</button><button>2</button>')
    const first = container.querySelector('button')

    const event = tabEvent(false)
    trapTabFocus(event, container)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('Shift+Tab 且焦点在首位 → 回绕到末位', () => {
    const container = setupContainer('<button>1</button><button>2</button><button>3</button>')
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('button'))
    buttons[0]?.focus()

    const event = tabEvent(true)
    trapTabFocus(event, container)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(buttons[2])
  })

  it('disabled 元素不参与聚焦循环', () => {
    const container = setupContainer(
      '<button disabled>0</button><button>1</button><button disabled>2</button>'
    )
    const enabled = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled])'))
    enabled[1]?.focus()

    const event = tabEvent(false)
    trapTabFocus(event, container)

    expect(document.activeElement).toBe(enabled[0])
  })

  it('非 Tab 键不拦截', () => {
    const container = setupContainer('<button>1</button>')
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })

    trapTabFocus(event, container)

    expect(event.defaultPrevented).toBe(false)
  })

  it('container 为空时不处理（无焦点圈定对象）', () => {
    const event = tabEvent(false)
    trapTabFocus(event, null)
    expect(event.defaultPrevented).toBe(false)
  })
})
