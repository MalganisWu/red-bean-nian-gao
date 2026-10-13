import * as React from 'react'
import { Avatar as BaseAvatar } from '@base-ui/react/avatar'

import { cn } from '../lib/utils'

/**
 * 头像根容器：给出方形基准尺寸、圆形裁剪与描边底色，内部图片与回退文字由
 * `Avatar.Image` / `Avatar.Fallback` 填入，两者通常成对使用。
 *
 * 底色与描边都取自语义 token，Light / Dark 两套主题下都保持足够对比；尺寸固定为
 * 32px 方阵，需要其它规格时由调用方经 `className` 覆盖而不是改这里。
 *
 * @param props - 透传给 base-ui 头像根元素的属性；`className` 追加在内置样式之后，
 *   `ref` 指向根元素，其余属性原样落到根元素上。
 * @returns 圆形裁剪的头像根元素。
 */
const Avatar = (props: React.ComponentPropsWithRef<typeof BaseAvatar.Root>): React.ReactElement => {
  const { className, ref, ...rest } = props
  return (
    <BaseAvatar.Root
      ref={ref}
      className={cn(
        'relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full border border-border-strong bg-background',
        className
      )}
      {...rest}
    />
  )
}

/**
 * 头像图片：铺满根容器并按 `object-cover` 裁剪，避免非正方形图片被拉伸变形。
 *
 * 图片处于加载中或加载失败时 base-ui 都不渲染本元素，改由同级的 `Avatar.Fallback`
 * 顶替，因此单独使用本元素会留下空容器。
 *
 * @param props - 透传给 base-ui 头像图片元素的属性；`className` 追加在铺满与裁剪样式之后，
 *   `ref` 指向图片元素。
 * @returns 铺满头像容器的图片元素。
 */
const AvatarImage = (
  props: React.ComponentPropsWithRef<typeof BaseAvatar.Image>
): React.ReactElement => {
  const { className, ref, ...rest } = props
  return (
    <BaseAvatar.Image
      ref={ref}
      className={cn('aspect-square h-full w-full object-cover', className)}
      {...rest}
    />
  )
}

/**
 * 头像回退：图片缺失或尚未加载完成时显示的占位，通常放姓名首字母等短文本。
 *
 * 字号与前景色走语义 token，Light / Dark 下都保持次级可读性；背景与根容器同为
 * `background`，图片与回退切换时不会出现底色跳变。
 *
 * @param props - 透传给 base-ui 回退元素的属性；`className` 追加在居中与排版样式之后，
 *   `ref` 指向回退元素。
 * @returns 居中排版的头像回退元素。
 */
const AvatarFallback = (
  props: React.ComponentPropsWithRef<typeof BaseAvatar.Fallback>
): React.ReactElement => {
  const { className, ref, ...rest } = props
  return (
    <BaseAvatar.Fallback
      ref={ref}
      className={cn(
        'flex h-full w-full items-center justify-center bg-background font-sans text-xs font-semibold text-foreground-body',
        className
      )}
      {...rest}
    />
  )
}

/** 把根容器与 `Image` / `Fallback` 组装成带命名空间的复合件，对外统一以 `Avatar` 导出。 */
const AvatarComponent = Object.assign(Avatar, {
  Image: AvatarImage,
  Fallback: AvatarFallback,
})

export { AvatarComponent as Avatar }
