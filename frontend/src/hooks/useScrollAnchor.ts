import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** 自动滚动到底部（新消息到达时） */
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
