import { useEffect, useRef } from 'react'
import type { RefObject, UIEvent } from 'react'

/** 距底部超过该像素数视为用户主动上滚；回到底部阈值内自动恢复跟随。 */
export const FOLLOW_TAIL_THRESHOLD_PX = 40

/** 跟随选项；`contentKey` 引用变化即视为内容增长（传展示内容数组的当前引用即可）。 */
export interface FollowTailOptions {
  /**
   * 跟随生效期（流式进行中传 true）。false 时跟随意图复位：
   * 下一轮流式（或会话切换后）默认重新从贴底开始跟随。
   */
  active: boolean
  /**
   * 跟随的内容键：引用变化即视为内容增长，若处于跟随中则把容器滚到底部。
   * 传展示内容数组的当前引用（如 displayTurns）即可。
   */
  contentKey: unknown
}

/** 跟随所需的两处绑定：容器 ref 与 onScroll 处理器。 */
export interface FollowTail {
  /** 绑定到滚动容器的 ref。 */
  readonly containerRef: RefObject<HTMLDivElement | null>
  /** 绑定到滚动容器 onScroll：判定用户上滚暂停 / 回底恢复。 */
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void
}

/**
 * 流式视图的「跟随尾部」滚动：内容增长时自动贴底，用户上滚暂停、回到底部附近恢复。
 *
 * 实现取舍：
 * - 跟随意图存在 ref 里（滚动事件高频触发，不需要每次都重渲染）；
 * - 自动滚动的 effect 只做 DOM 写入、不做 setState（react-hooks 规则：effect 体内不同步 setState）；
 * - 暂停只在本轮流式内有效：active 翻假（流结束/切会话）即复位，下一轮流重新跟随。
 */
export function useFollowTail({ active, contentKey }: FollowTailOptions): FollowTail {
  const containerRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  useEffect(resetFollowIntent, [active])
  useEffect(scrollToBottom, [active, contentKey])

  /* 跟随窗口关闭时复位跟随意图：避免上一轮的「用户上滚」状态带进下一轮流 */
  function resetFollowIntent(): void {
    if (active) return
    followRef.current = true
  }

  /* 内容增长时贴底：仅在跟随生效且用户未上滚暂停时执行 */
  function scrollToBottom(): void {
    if (!active || !followRef.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }

  /** 滚动事件：按距底距离判定用户上滚暂停 / 回底恢复跟随。 */
  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const el = event.currentTarget
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    /* 程序化贴底后该距离为 0，不会误判为上滚 */
    followRef.current = distanceToBottom <= FOLLOW_TAIL_THRESHOLD_PX
  }

  return { containerRef, onScroll }
}
