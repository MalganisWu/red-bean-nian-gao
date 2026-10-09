import { collapseToProcessFold } from './processSections'
import type { MessageSection } from '@/types/chat'

/**
 * normalizeSections：消息 sections 渲染入口归一化。
 * 委托 collapseToProcessFold 收束为 `[process?, content?]` 模型
 * （spec: process-fold-timeline §2/§6）——一轮里除最终 content 外的全部
 * section 平铺为同一个 Process；card 是其中的 approval 节点。
 *
 * 纯渲染层收束：不动持久化数据；同一函数处理实时流与历史 sections。
 * 前提：上游 sections append-only，收束是纯净重算，无状态残留。
 */
export function normalizeSections(
  sections: MessageSection[],
  opts?: { isStreaming?: boolean | undefined }
): MessageSection[] {
  return collapseToProcessFold(sections, { isStreaming: opts?.isStreaming ?? false })
}
