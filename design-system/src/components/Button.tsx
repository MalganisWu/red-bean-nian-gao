import { Button as BaseButton } from '@base-ui/react/button'
import { cva } from 'class-variance-authority'
import React from 'react'
import type { ButtonHTMLAttributes } from 'react'

import { cn } from '../lib/utils'

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center rounded-md border font-sans font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-transparent text-action-confirm hover:bg-primary-soft hover:text-action-confirm-hover active:text-action-confirm-hover',
        secondary:
          'border-border bg-secondary text-secondary-foreground hover:bg-secondary-hover hover:text-foreground',
        outline:
          'border-control-border bg-background text-foreground-body hover:border-foreground-faint hover:text-foreground',
        destructive:
          'border-transparent bg-transparent text-danger hover:underline hover:underline-offset-4',
        'destructive-outline':
          'border-danger/40 bg-transparent text-danger hover:bg-danger-bg hover:border-danger',
        solid: 'border-foreground bg-foreground text-background hover:opacity-85 active:opacity-75',
        link: 'border-transparent bg-transparent text-action-confirm hover:underline hover:underline-offset-4',
        ghost:
          'border-transparent bg-transparent text-foreground-muted hover:bg-surface-hover hover:text-foreground',
      },
      size: {
        sm: 'min-h-11 px-3 text-xs sm:min-h-8',
        md: 'min-h-11 px-3 text-[13px] sm:min-h-9',
        lg: 'min-h-12 px-4 text-sm sm:min-h-10',
        icon: 'h-11 w-11 p-0 sm:h-9 sm:w-9',
      },
    },
    defaultVariants: {
      size: 'md',
      variant: 'default',
    },
  }
)

export interface IButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | 'default'
    | 'secondary'
    | 'outline'
    | 'destructive'
    | 'destructive-outline'
    | 'solid'
    | 'link'
    | 'ghost'
  size?: 'sm' | 'md' | 'lg' | 'icon'
  render?: React.ComponentProps<typeof BaseButton>['render']
}

export const Button = ({
  children,
  size = 'md',
  className = '',
  variant = 'default',
  render,
  ref,
  ...props
}: IButtonProps & { ref?: React.Ref<HTMLButtonElement> }): React.ReactElement => {
  return (
    <BaseButton
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      render={render}
      {...props}
    >
      {children}
    </BaseButton>
  )
}
