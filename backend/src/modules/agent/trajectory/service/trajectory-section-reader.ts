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

/** `tools[]` 元素的形状守卫；字段刻意全是 `unknown`，读取方必须逐个收窄后才能用。 */
export interface ToolItemLike {
  readonly callId?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
  readonly duration?: unknown
}

/** `sub_agent` 段落的形状守卫；键名沿用落库时的 snake_case，不在这里改名。 */
export interface SubAgentSectionLike {
  readonly agent_id?: unknown
  readonly agent_name?: unknown
  readonly execution_id?: unknown
  readonly parent_call_id?: unknown
  readonly status?: unknown
  readonly result_summary?: unknown
}

/** 非 null 且非数组的对象判定；数组在这里一律不算「记录」。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受字符串；数字、布尔、null 一律返回 null，不做隐式转换。 */
export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 读毫秒时间戳；非有限数退回 0，时间戳 0 本身没有现实语义，可安全当「无时间」。 */
export function readMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 读耗时毫秒；非法值返回 null——这里不能像 `readMs` 那样退回 0，因为 0 毫秒是合法耗时。 */
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
