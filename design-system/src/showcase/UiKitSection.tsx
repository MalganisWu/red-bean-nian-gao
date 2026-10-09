import type { ReactNode } from 'react'

interface UiKitSectionProps {
  title: string
  children: ReactNode
}

export function UiKitSection({ title, children }: UiKitSectionProps) {
  return (
    <div className="uikit-section">
      <h3 className="uikit-section-title">{title}</h3>
      {children}
    </div>
  )
}

interface UiKitRowProps {
  /** 内容类组件纵向全宽堆叠，展开不换行重排 */
  stack?: boolean
  children: ReactNode
}

export function UiKitRow({ stack, children }: UiKitRowProps) {
  return (
    <div className={stack ? 'component-row component-row--stack' : 'component-row'}>{children}</div>
  )
}

interface UiKitItemProps {
  label?: string
  /** 配合 UiKitRow stack：item 拉伸到 row 全宽，label 左对齐 */
  block?: boolean
  children: ReactNode
}

export function UiKitItem({ label, block, children }: UiKitItemProps) {
  return (
    <div className={block ? 'component-item component-item--block' : 'component-item'}>
      {children}
      {label && <span className="component-label">{label}</span>}
    </div>
  )
}
