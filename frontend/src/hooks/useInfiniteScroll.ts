import { useCallback, useRef } from 'react'
import type { RefObject, UIEventHandler } from 'react'

interface InfiniteScrollControls {
  listRef: RefObject<HTMLDivElement | null>
  handleScroll: UIEventHandler<HTMLDivElement>
}

/** 滚动到底部（剩余 <50px）时触发 loadMore（TasksPage / SessionSidebar 共用） */
export function useInfiniteScroll(
  loadMore: () => void,
  hasMore: boolean,
  loading: boolean
): InfiniteScrollControls {
  const listRef = useRef<HTMLDivElement>(null)

  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el || loading || !hasMore) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) {
      loadMore()
    }
  }, [loading, hasMore, loadMore])

  return { listRef, handleScroll }
}
