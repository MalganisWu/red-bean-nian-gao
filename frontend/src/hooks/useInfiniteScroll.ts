import { useCallback, useRef } from 'react'
import type { RefObject, UIEventHandler } from 'react'

interface InfiniteScrollControls {
  listRef: RefObject<HTMLDivElement | null>
  handleScroll: UIEventHandler<HTMLDivElement>
}

/**
 * 滚动到底部（剩余 <50px）时触发 loadMore（TasksPage / SessionSidebar 共用）
 *
 * @param loadMore - 触底时的加载回调；是否重复触发由 hasMore / loading 共同拦截，调用方无需自行防抖。
 * @param hasMore - 是否还有下一页；为 false 时触底不再回调。
 * @param loading - 是否正在加载；为 true 时抑制触底回调，避免同一次滚动并发发起多页请求。
 * @returns 列表容器 ref 与 onScroll 处理器。
 */
export function useInfiniteScroll(
  loadMore: () => void,
  hasMore: boolean,
  loading: boolean
): InfiniteScrollControls {
  const listRef = useRef<HTMLDivElement>(null)

  const handleScroll = useCallback(
    /** 滚动到底部（剩余 <50px）且仍有下一页时触发 loadMore。 */
    function handleListScroll(): void {
      const el = listRef.current
      if (!el || loading || !hasMore) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) {
        loadMore()
      }
    },
    [loading, hasMore, loadMore]
  )

  return { listRef, handleScroll }
}
