import type { InputHTMLAttributes } from 'react'

import { cn } from '../lib/utils'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string
}

export function Input({
  type = 'text',
  placeholder = '输入文本',
  className = '',
  ...props
}: InputProps): React.ReactElement {
  return (
    <input
      type={type}
      placeholder={placeholder}
      className={cn(
        'h-10 w-full rounded-md border border-control-border bg-input px-3 py-0 font-sans text-[13px] text-foreground transition-colors duration-150 placeholder:text-foreground-faint hover:border-foreground-faint focus-visible:border-brand-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:bg-muted disabled:text-foreground-faint aria-invalid:border-danger-text aria-invalid:focus-visible:ring-danger-indicator',
        className
      )}
      {...props}
    />
  )
}
