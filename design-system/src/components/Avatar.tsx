import * as React from 'react'
import { Avatar as BaseAvatar } from '@base-ui/react/avatar'

import { cn } from '../lib/utils'

const Avatar = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithRef<typeof BaseAvatar.Root>): React.ReactElement => (
  <BaseAvatar.Root
    ref={ref}
    className={cn(
      'relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full border border-border-strong bg-background',
      className
    )}
    {...props}
  />
)

const AvatarImage = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithRef<typeof BaseAvatar.Image>): React.ReactElement => (
  <BaseAvatar.Image
    ref={ref}
    className={cn('aspect-square h-full w-full object-cover', className)}
    {...props}
  />
)

const AvatarFallback = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithRef<typeof BaseAvatar.Fallback>): React.ReactElement => (
  <BaseAvatar.Fallback
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center bg-background font-sans text-xs font-semibold text-foreground-body',
      className
    )}
    {...props}
  />
)

const AvatarComponent = Object.assign(Avatar, {
  Image: AvatarImage,
  Fallback: AvatarFallback,
})

export { AvatarComponent as Avatar }
