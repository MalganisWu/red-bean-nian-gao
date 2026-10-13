import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 自动滚动到底部（新消息到达时）
 *
 * @param messagesDependency - 消息列表依赖标识；引用变化视为有新消息，触发贴底。
 * @param pendingDependency - 在途内容（如待答卡片）依赖标识；变化同样触发贴底，保证流式期间也持续跟随。
 * @returns 需绑定到滚动容器的 ref。
 */
export function useScrollAnchor(
  messagesDependency: unknown,
  pendingDependency: unknown
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(anchorToBottom, [messagesDependency, pendingDependency])

  /** 依赖变化时把容器滚到底部。 */
  function anchorToBottom(): void {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }

  return ref
}
