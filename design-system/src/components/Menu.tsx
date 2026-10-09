'use client'

import { Menu as BaseMenu } from '@base-ui/react/menu'
import React from 'react'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '../lib/utils'

const Menu = BaseMenu.Root
const Trigger = BaseMenu.Trigger

interface IMenuContent extends ComponentPropsWithoutRef<typeof BaseMenu.Popup> {
  className?: string
}

const Content = ({
  className,
  style,
  ...props
}: IMenuContent & { style?: React.CSSProperties }): React.ReactElement => (
  <BaseMenu.Portal>
    <BaseMenu.Positioner sideOffset={6}>
      <BaseMenu.Popup
        className={cn(
          'min-w-40 rounded-lg border border-border-strong bg-popover p-1 text-foreground shadow-lg outline-none',
          className
        )}
        style={style}
        {...props}
      />
    </BaseMenu.Positioner>
  </BaseMenu.Portal>
)

const MenuItem = React.forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof BaseMenu.Item>>(
  ({ className, ...props }, ref) => (
    <BaseMenu.Item
      ref={ref}
      className={cn(
        'relative flex min-h-11 cursor-default select-none items-center gap-2 rounded-sm px-2.5 py-1.5 font-sans text-xs text-foreground-body outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus:bg-surface-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40 sm:min-h-[34px]',
        className
      )}
      {...props}
    />
  )
)
MenuItem.displayName = 'MenuItem'

const MenuSeparator = ({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof BaseMenu.Separator>): React.ReactElement => (
  <BaseMenu.Separator className={cn('mx-1 my-1 h-px bg-border', className)} {...props} />
)

const MenuComponent = Object.assign(Menu, {
  Trigger,
  Content,
  Item: MenuItem,
  Separator: MenuSeparator,
})

export { MenuComponent as Menu }
