'use client'

import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import { cva } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../lib/utils'

/** 提示气泡的视觉变体；`default` 为深底浅字的高对比浮层，不改动时为它。 */
type TooltipVariantProps = {
  /** 变体名；`default`/`primary`/`solid` 目前在基础样式上等价，留作后续按语境分化。 */
  variant?: 'default' | 'primary' | 'solid'
}

/**
 * 提示气泡的类名生成器：底/字色用 `foreground` 与 `background` 这组互为反色的语义 token，
 * 因此 Light/Dark 两套主题下都保持「深底浅字」的对比关系。
 */
const tooltipContentVariants = cva(
  'z-50 max-w-56 overflow-hidden rounded-sm border border-foreground bg-foreground px-2 py-1.5 font-sans text-xs leading-snug text-background shadow-none animate-in fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0',
  {
    variants: {
      variant: {
        default: '',
        primary: '',
        solid: '',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

/** 提示组件的上下文提供者：包裹需要共享延迟与跳转行为的整块区域。 */
const TooltipProvider = BaseTooltip.Provider

/** 提示的根组件：管理开合状态，本身不渲染内容。 */
const Tooltip = BaseTooltip.Root

/** 触发元素：悬停或聚焦它时打开提示。 */
const TooltipTrigger = BaseTooltip.Trigger

/**
 * 提示气泡本体：套一层 Portal + Positioner，把变体类名与调用方的 className 合并后交给
 * Base UI 的 Popup，其余属性原样透传。
 *
 * @param props - Base UI Popup 的属性，外加本组件的 `variant` 变体选择。
 * @returns 渲染在 Portal 中的提示气泡元素。
 */
const TooltipContent = (
  props: React.ComponentPropsWithRef<typeof BaseTooltip.Popup> & TooltipVariantProps
): React.ReactElement => {
  const { className, variant, ref, style, ...rest } = props
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner sideOffset={8}>
        <BaseTooltip.Popup
          ref={ref}
          className={cn(
            tooltipContentVariants({
              variant,
              className,
            })
          )}
          style={style}
          {...rest}
        />
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  )
}

/** 组合出对外出口：把 Trigger/Content/Provider 挂在根组件上，调用方按 `Tooltip.Trigger` 等取用。 */
const TooltipObject = Object.assign(Tooltip, {
  Trigger: TooltipTrigger,
  Content: TooltipContent,
  Provider: TooltipProvider,
})

export { TooltipObject as Tooltip }
