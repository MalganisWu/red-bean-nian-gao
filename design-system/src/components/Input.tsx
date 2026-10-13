import type { InputHTMLAttributes } from 'react'

import { cn } from '../lib/utils'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string
}

/**
 * 文本输入原子件；`type` 与 `placeholder` 有缺省值，其余属性透传给原生 input。
 *
 * @param props - 组件属性；`type` / `placeholder` 有缺省值，`className` 追加在内置样式之后，
 *   其余未知属性原样落到 `input` 上。
 * @returns 一个宿主可继续追加属性的文本输入元素。
 */
export function Input(props: InputProps): React.ReactElement {
  const { type = 'text', placeholder = '输入文本', className = '', ...rest } = props
  return (
    <input
      type={type}
      placeholder={placeholder}
      className={cn(
        'h-10 w-full rounded-md border border-control-border bg-input px-3 py-0 font-sans text-[13px] text-foreground transition-colors duration-150 placeholder:text-foreground-faint hover:border-foreground-faint focus-visible:border-brand-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:bg-muted disabled:text-foreground-faint aria-invalid:border-danger-text aria-invalid:focus-visible:ring-danger-indicator',
        className
      )}
      {...rest}
    />
  )
}
