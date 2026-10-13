/*
 * 原子件 · Button。
 * 设计系统的按钮基元：变体与尺寸由 `buttonVariants` 一处给出，调用方只选择组合，
 * 不自行拼接 Tailwind 类——否则「主按钮长什么样」会在各处漂移。
 */
import { Button as BaseButton } from '@base-ui/react/button'
import { cva } from 'class-variance-authority'
import React from 'react'
import type { ButtonHTMLAttributes } from 'react'

import { cn } from '../lib/utils'

/**
 * 按钮的变体与尺寸表：把「主按钮长什么样」收敛到这一处，调用方只选组合。
 *
 * 变体负责语义与配色（如 `destructive` 与 `destructive-outline` 语义相同、视觉权重不同），
 * 尺寸负责高度与内边距；移动端最小高度抬到 44px 满足触控目标，`sm:` 起回落桌面尺寸。
 * 所有颜色取自语义 token，Light / Dark 下由 token 各自给出正确取值。
 */
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

/** 按钮 Props；`variant` / `size` 走内置变体表，其余属性透传给底层 button 元素。 */
export interface IButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * 视觉变体，默认 `default`（文字型主操作）。
   * `destructive` 是文字型危险操作，`destructive-outline` 是描边型危险操作，两者语义相同、视觉权重不同。
   */
  variant?:
    | 'default'
    | 'secondary'
    | 'outline'
    | 'destructive'
    | 'destructive-outline'
    | 'solid'
    | 'link'
    | 'ghost'
  /** 尺寸，默认 `md`；`icon` 是正方形图标位，不承载文本。 */
  size?: 'sm' | 'md' | 'lg' | 'icon'
  /** 透传给 base-ui 的 render 槽，用于把按钮渲染成其它元素（如链接）。 */
  render?: React.ComponentProps<typeof BaseButton>['render']
}

/**
 * 按钮组件；`children` 为内容，其余属性原样透传，`className` 追加在内置变体之后。
 *
 * @param props - 组件属性；`variant` / `size` 走内置变体表，`render` 交给 base-ui 的渲染槽，
 *   其余未知属性原样落到 `button` 上。
 * @returns 一个宿主可继续追加属性与 children 的按钮元素。
 */
export function Button(
  props: IButtonProps & { ref?: React.Ref<HTMLButtonElement> }
): React.ReactElement {
  const { children, size = 'md', className = '', variant = 'default', render, ref, ...rest } = props
  return (
    <BaseButton
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      render={render}
      {...rest}
    >
      {children}
    </BaseButton>
  )
}
