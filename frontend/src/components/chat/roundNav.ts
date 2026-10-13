import { formatDurationMs, roundTotalDurationMs } from './processSections'
import type { DisplayMessage, MessageSection } from '@/types/chat'

/** 一轮导航条目：一根横杠 + 悬停摘要所需的全部数据（截断在渲染层做） */
export interface RoundNavItem {
  /** user 消息 id（DOM 锚点） */
  messageId: string
  /** 用户原话 */
  question: string
  /** 该轮 assistant 最终回答（最后一个 content）；无响应（出错/取消/流式中）则 undefined */
  answer?: string
  /** 回合总耗时（包络公式，process-fold 口径）；无法计算则 undefined */
  totalDuration?: string
  /** 该轮工具调用数；0 则 undefined */
  toolCount?: number
}

/**
 * assistant 消息的最终回答文本：最后一个 content section；无 sections 回退 content 字段
 *
 * @param m - 待取回答的展示消息；通常是紧随 user 的那条 assistant。
 * @returns 最终回答文本；既无非空 content section 又无 content 时返回 undefined。
 */
function finalAnswerOf(m: DisplayMessage): string | undefined {
  const sections = m.sections
  if (!sections || sections.length === 0) return m.content || undefined
  const finalSection = sections.findLast(
    (section): section is Extract<MessageSection, { type: 'content' }> =>
      section.type === 'content' && Boolean(section.content)
  )
  if (finalSection) return finalSection.content
  return m.content || undefined
}

/**
 * 该轮工具调用数：tool_group.tools + reason 内嵌 tool items（sub_agent 的委派调用已含在 tool_group 内）
 *
 * @param sections - 该轮 assistant 消息的分区列表；只统计 tool_group 与 reason 两类。
 * @returns 工具调用总数；为 0 表示该轮没有任何工具调用。
 */
function toolCountOf(sections: MessageSection[]): number {
  let n = 0
  for (const s of sections) {
    if (s.type === 'tool_group') n += s.tools.length
    else if (s.type === 'reason') n += s.items.filter((it) => it.itemType === 'tool').length
  }
  return n
}

/**
 * 轮次导航派生：一条 user 消息 = 一轮；紧随其后的第一条 assistant 消息提供
 * 回答摘要 / 总耗时 / 工具数。纯函数，实时流与历史共用（spec: round-nav-gutter §6）。
 *
 * @param messages - 展示消息列表；只取 user 消息建轮，紧随其后的 assistant 提供摘要。
 * @returns 与 user 消息一一对应的导航条目列表，无 assistant 响应时摘要字段缺省。
 */
export function roundNavItems(messages: DisplayMessage[]): RoundNavItem[] {
  const items: RoundNavItem[] = []
  for (const [i, m] of messages.entries()) {
    if (m.role !== 'user') continue
    const item: RoundNavItem = { messageId: m.id, question: m.content ?? '' }

    // 紧随的第一条 assistant（中间无其他 user）
    const next = messages[i + 1]
    if (next && next.role === 'assistant') {
      const answer = finalAnswerOf(next)
      if (answer !== undefined) item.answer = answer
      if (next.sections && next.sections.length > 0) {
        const total = roundTotalDurationMs(next.sections, next.meta)
        if (total !== undefined) item.totalDuration = formatDurationMs(total)
        const count = toolCountOf(next.sections)
        if (count > 0) item.toolCount = count
      }
    }
    items.push(item)
  }
  return items
}
