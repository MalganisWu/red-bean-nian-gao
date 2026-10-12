'use client'

import { Toaster as Sonner } from 'sonner'

type ToasterProps = React.ComponentProps<typeof Sonner>

/** 通知浮层出口：装配 Quiet Tool 的通知样式并透传其余 Toaster 属性。 */
function Toaster({ ...props }: ToasterProps): React.ReactElement {
  return (
    <Sonner
      toastOptions={{
        classNames: {
          toast:
            'group toast relative flex h-auto w-full items-start gap-2.5 rounded-lg border border-border-strong bg-popover p-3.5 font-sans text-foreground shadow-lg',
          content: 'min-w-0 flex-1',
          icon: 'mt-0.5 h-[18px] w-[18px] shrink-0 text-foreground-muted',
          success: '[&_[data-icon]]:text-success-indicator',
          error: '[&_[data-icon]]:text-danger-indicator',
          title: 'font-sans text-[13px] font-semibold leading-normal text-foreground',
          description: 'mt-0.5 font-sans text-xs leading-normal text-foreground-muted',
          actionButton:
            'ml-auto h-fit min-w-fit shrink-0 border-0 bg-transparent px-0 py-0.5 font-sans text-xs font-medium text-action-confirm transition-colors duration-150 hover:text-action-confirm-hover',
          cancelButton:
            'ml-auto h-fit min-w-fit shrink-0 border-0 bg-transparent px-0 py-0.5 font-sans text-xs text-foreground-muted transition-colors duration-150 hover:text-foreground',
          closeButton:
            'absolute -left-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-border-strong bg-popover text-foreground-muted',
        },
        unstyled: true,
      }}
      {...props}
    />
  )
}

export { Toaster }
