'use client'

import { Menu as BaseMenu } from '@base-ui/react/menu'
import React from 'react'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '../lib/utils'

/** 菜单根容器；承载开合状态与键盘导航，直接复用 base-ui 的 Root，不做二次封装。 */
const Menu = BaseMenu.Root
/** 菜单触发器；点击或回车后由 base-ui 依据根容器状态打开对应的 `Content`。 */
const Trigger = BaseMenu.Trigger

/** 菜单弹层的 Props；`className` 追加在弹层内置样式之后。 */
interface IMenuContent extends ComponentPropsWithoutRef<typeof BaseMenu.Popup> {
  /** 追加在弹层样式之后的类名；用于调宽窄或对齐，配色仍走语义 token。 */
  className?: string
}

/**
 * 菜单弹层：自带 Portal 与定位器，渲染到文档流之外并按触发元素定位。
 *
 * 弹层的边框、阴影与 `popover` 底色都取自语义 token，Light / Dark 下由 token 各自
 * 给出正确取值；`sideOffset` 固定 6px，避免弹层贴死触发器。
 *
 * @param props - 透传给 base-ui 弹层元素的属性；`className` 追加在内置样式之后，
 *   `style` 为调用方追加的内联样式，其余属性原样落到弹层上。
 * @returns 经 Portal 渲染的菜单弹层。
 */
const Content = (props: IMenuContent & { style?: React.CSSProperties }): React.ReactElement => {
  const { className, style, ...rest } = props
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner sideOffset={6}>
        <BaseMenu.Popup
          className={cn(
            'min-w-40 rounded-lg border border-border-strong bg-popover p-1 text-foreground shadow-lg outline-none',
            className
          )}
          style={style}
          {...rest}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

/**
 * 菜单项；用 `forwardRef` 是为了让 base-ui 的键盘导航能把焦点落到条目上。
 *
 * 悬停与聚焦复用同一组 `surface-hover` 背景，键盘与鼠标体验一致；禁用态经
 * `data-[disabled]` 降透明度并屏蔽指针事件，配色在 Light / Dark 下都由 token 保证对比。
 *
 * @param props - base-ui 菜单项属性；`className` 追加在内置样式之后，其余原样透传。
 * @param ref - 转发给底层条目元素的引用，键盘导航据此把焦点落到这一项上。
 */
const MenuItem = React.forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof BaseMenu.Item>>(
  (props, ref) => {
    const { className, ...rest } = props
    return (
      <BaseMenu.Item
        ref={ref}
        className={cn(
          'relative flex min-h-11 cursor-default select-none items-center gap-2 rounded-sm px-2.5 py-1.5 font-sans text-xs text-foreground-body outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus:bg-surface-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40 sm:min-h-[34px]',
          className
        )}
        {...rest}
      />
    )
  }
)
MenuItem.displayName = 'MenuItem'

/**
 * 菜单分隔线：一条 1px 的水平线，用 `border` 语义色绘制，用于给菜单项分组。
 *
 * @param props - 透传给 base-ui 分隔元素的属性；`className` 追加在间距与线色之后。
 * @returns 分隔菜单分组的水平线元素。
 */
const MenuSeparator = (
  props: ComponentPropsWithoutRef<typeof BaseMenu.Separator>
): React.ReactElement => {
  const { className, ...rest } = props
  return <BaseMenu.Separator className={cn('mx-1 my-1 h-px bg-border', className)} {...rest} />
}

/** 把根容器与 `Trigger` / `Content` / `Item` / `Separator` 组装成复合件，对外统一以 `Menu` 导出。 */
const MenuComponent = Object.assign(Menu, {
  Trigger,
  Content,
  Item: MenuItem,
  Separator: MenuSeparator,
})

export { MenuComponent as Menu }
