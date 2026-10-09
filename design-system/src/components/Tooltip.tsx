'use client'

import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import { cva } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../lib/utils'

type TooltipVariantProps = {
  variant?: 'default' | 'primary' | 'solid'
}

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

const TooltipProvider = BaseTooltip.Provider

const Tooltip = BaseTooltip.Root

const TooltipTrigger = BaseTooltip.Trigger

const TooltipContent = ({
  className,
  variant,
  ref,
  style,
  ...props
}: React.ComponentPropsWithRef<typeof BaseTooltip.Popup> &
  TooltipVariantProps): React.ReactElement => (
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
        {...props}
      />
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>
)

const TooltipObject = Object.assign(Tooltip, {
  Trigger: TooltipTrigger,
  Content: TooltipContent,
  Provider: TooltipProvider,
})

export { TooltipObject as Tooltip }
