import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** 自动滚动到底部（新消息到达时） */
export function useScrollAnchor(
  messagesDependency: unknown,
  pendingDependency: unknown
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [messagesDependency, pendingDependency])

  return ref
}
