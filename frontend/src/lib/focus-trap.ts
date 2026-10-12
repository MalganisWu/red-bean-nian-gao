/**
 * 抽屉/模态焦点陷阱：把 Tab 循环圈在容器内（aria-modal 语义），防焦点漏到遮罩后的主内容区。
 * 焦点位于首位时 Shift+Tab、末位时 Tab、或焦点在容器外时，回绕到另一端并阻止默认行为。
 *
 * 事件参数使用最小结构接口：React 合成 KeyboardEvent 与原生 KeyboardEvent 都满足
 * {key, shiftKey, preventDefault}，调用方（onKeyDown）无需转换。
 */
export interface TabKeyEvent {
  key: string
  shiftKey: boolean
  preventDefault(): void
}

/** 把 Tab 键限制在容器内循环（模态框焦点圈定）；非 Tab 键或容器缺失时原样放行。 */
export function trapTabFocus(e: TabKeyEvent, container: HTMLElement | null): void {
  if (e.key !== 'Tab' || !container) return
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0)
  const first = focusables.at(0)
  const last = focusables.at(-1)
  if (!first || !last) return
  const active = document.activeElement
  if (e.shiftKey) {
    if (active === first || !container.contains(active)) {
      e.preventDefault()
      last.focus()
    }
  } else if (active === last || !container.contains(active)) {
    e.preventDefault()
    first.focus()
  }
}
