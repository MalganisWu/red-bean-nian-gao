import type { DisplayMessage } from '../../presentation/model/display-message.js'

/**
 * sections[] 在持久化层是 z.json 宽松载荷；本文件集中所有防御式读取工具，
 * 从 unknown 开始逐字段守卫，不让脏数据进入投影。
 */
export interface SectionLike {
  readonly type?: unknown
  readonly items?: unknown
  readonly tools?: unknown
  readonly content?: unknown
  readonly card?: unknown
  readonly timestamp?: unknown
  readonly duration?: unknown
}

export interface ToolItemLike {
  readonly callId?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
  readonly duration?: unknown
}

export interface SubAgentSectionLike {
  readonly agent_id?: unknown
  readonly agent_name?: unknown
  readonly execution_id?: unknown
  readonly parent_call_id?: unknown
  readonly status?: unknown
  readonly result_summary?: unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function readMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function readDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** sections 载荷可能是数组以外的脏数据；非数组按无 sections 处理，非对象段由守卫剔除。 */
export function readSections(message: DisplayMessage): readonly SectionLike[] | null {
  const sections: unknown = message.sections
  if (!Array.isArray(sections)) return null
  /* Array.isArray 把 unknown 收窄为 any[]，逐元素用对象守卫过滤（不做类型断言） */
  const out: Record<string, unknown>[] = []
  for (const item of sections) {
    if (isRecord(item)) out.push(item)
  }
  return out
}

/** reason 段的思考文本 = items[].content 顺序拼接。 */
export function readReasonText(section: SectionLike): string {
  const items = section['items']
  if (!Array.isArray(items)) return ''
  const parts: string[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const content = readString(item['content'])
    if (content !== null) parts.push(content)
  }
  return parts.join('\n')
}

/** 行摘要取首行，超长截断。 */
export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/** 会话标题：首条用户消息前 30 字符。 */
export function extractTitle(messages: readonly DisplayMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || message.content === undefined) continue
    const characters = Array.from(message.content)
    return characters.length > 30 ? `${characters.slice(0, 30).join('')}...` : message.content
  }
  return ''
}
