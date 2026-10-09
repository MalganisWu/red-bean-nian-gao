import type { DisplayMessage, MessageSection } from '@/types/chat'

// ── ask-card 续跑合并目标（stateless，从消息推导）────────────
// 用于：finalizeStreamingText 落库合并 + ChatMessages streaming 期间就地渲染，
// 两边用同一套逻辑，保证 streaming 视觉和最终结果一致。

// 消息里最后一张卡片 section 的索引（-1 = 无）。answer 提交期间卡片仍保持
// pending，因此流式续跑也必须能以 pending 卡片为原地合并目标。
export function findLastCardSectionIndex(sections: MessageSection[]): number {
  return sections.findLastIndex((section) => section.type === 'card')
}

// 续跑合并目标消息的索引：仅当【最后一条消息】含卡片 section 时，
// 它才是合并目标（answer 续跑只并进最后一条；交互后普通新消息的最后一条无卡片 → 不命中）。
export function findCardMergeTarget(messages: DisplayMessage[]): number {
  const lastMessage = messages.at(-1)
  if (!lastMessage) return -1
  if (findLastCardSectionIndex(lastMessage.sections ?? []) >= 0) {
    return messages.length - 1
  }
  return -1
}

/**
 * 把续跑 sections 合并进目标消息：插到最后一张卡片 section 之后（含二次提问的新卡片）。
 * 调用点前提是目标消息含卡片；无卡片时防御性追加到尾部，保证结果自洽。
 * 纯函数：不修改入参，返回新数组。
 */
export function mergeContinuation(
  sections: MessageSection[],
  continuation: MessageSection[]
): MessageSection[] {
  const cardIdx = findLastCardSectionIndex(sections)
  if (cardIdx < 0) return [...sections, ...continuation]
  return [...sections.slice(0, cardIdx + 1), ...continuation, ...sections.slice(cardIdx + 1)]
}
