/*
 * 内部件 · UiKit 排版骨架。
 * 展示站自身用的分区 / 行 / 单元三层容器，不对外承诺 API，也不单独出 showcase 页。
 */
import type { ReactNode } from 'react'

interface UiKitSectionProps {
  title: string
  children: ReactNode
}

/**
 * 一组组件的分区容器；`title` 渲染为分区标题。
 *
 * @param props - 组件属性；字段语义见 `UiKitSectionProps`。
 */
export function UiKitSection(props: UiKitSectionProps) {
  const { title, children } = props
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

/**
 * 一行组件示例；`stack` 让内容类组件纵向全宽堆叠，展开时不换行重排。
 *
 * @param props - 组件属性；字段语义见 `UiKitRowProps`。
 */
export function UiKitRow(props: UiKitRowProps) {
  const { stack, children } = props
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

/**
 * 单个组件示例；`block` 配合 row 的 stack 拉伸到整行，并使标签左对齐。
 *
 * @param props - 组件属性；字段语义见 `UiKitItemProps`。
 */
export function UiKitItem(props: UiKitItemProps) {
  const { label, block, children } = props
  return (
    <div className={block ? 'component-item component-item--block' : 'component-item'}>
      {children}
      {label && <span className="component-label">{label}</span>}
    </div>
  )
}
