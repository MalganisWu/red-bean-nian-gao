import type { DisplayMessage } from '../../presentation/model/display-message.js'

/**
 * sections[] 在持久化层是 z.json 宽松载荷；本文件集中所有防御式读取工具，
 * 从 unknown 开始逐字段守卫，不让脏数据进入投影。
 */
export interface SectionLike {
  /** 段类型判别值；由投影层与本文件共享的常量集解释，取值不合法即静默跳过该段。 */
  readonly type?: unknown
  /** 段的子项数组（reason 的思考片段、sub_agent 的载荷等）；非数组按空缺处理。 */
  readonly items?: unknown
  /** tool_group 段的工具项数组；非数组按空处理，不视为错误。 */
  readonly tools?: unknown
  /** content 段的正文文本；非字符串按空缺处理。 */
  readonly content?: unknown
  /** card 段的卡片载荷（审批交互状态）；非对象按无卡片处理。 */
  readonly card?: unknown
  /** 段发生时刻（epoch 毫秒）；非法值退回 0。 */
  readonly timestamp?: unknown
  /** 段耗时（毫秒）；非法值退回 null，与合法的 0 区分。 */
  readonly duration?: unknown
}

/** `tools[]` 元素的形状守卫；字段刻意全是 `unknown`，读取方必须逐个收窄后才能用。 */
export interface ToolItemLike {
  /** 工具调用 id；当前仅供潜在的去重与关联使用。 */
  readonly callId?: unknown
  /** 工具名；唯一硬性字段，缺失即丢弃该工具项。 */
  readonly name?: unknown
  /** 工具结局（如 success / failed）；非字符串按未知处理。 */
  readonly status?: unknown
  /** 工具入参的 JSON 文本；非字符串按空缺处理。 */
  readonly params?: unknown
  /** 工具成功结果文本；非字符串按空缺处理。 */
  readonly result?: unknown
  /** 工具失败文本；非字符串按空缺处理。 */
  readonly error?: unknown
  /** 工具耗时（毫秒）；非法值退回 null。 */
  readonly duration?: unknown
}

/** `sub_agent` 段落的形状守卫；键名沿用落库时的 snake_case，不在这里改名。 */
export interface SubAgentSectionLike {
  /** 子 Agent 定义 id，落库键沿用 snake_case。 */
  readonly agent_id?: unknown
  /** 子 Agent 展示名；缺失时回落到子执行记录或固定文案。 */
  readonly agent_name?: unknown
  /** 子执行 id；用于与子执行记录对账。 */
  readonly execution_id?: unknown
  /** 父运行里触发本次委派的工具调用 id；据此并入子执行记录。 */
  readonly parent_call_id?: unknown
  /** 子运行状态；非字符串或缺失时回落到子执行记录。 */
  readonly status?: unknown
  /** 子运行结果摘要；缺失时回落到子执行记录或名称。 */
  readonly result_summary?: unknown
}

/**
 * 非 null 且非数组的对象判定；数组在这里一律不算「记录」。
 *
 * @param value - 待判定的任意值，通常来自宽松载荷的字段。
 * @returns 是否为可安全按字符串键取值的对象；真值同时充当类型收窄守卫。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 只接受字符串；数字、布尔、null 一律返回 null，不做隐式转换。
 *
 * @param value - 待读取的任意字段值；非字符串一律当作缺失。
 * @returns 原字符串；非字符串时为 null，调用方据此决定回落或跳过。
 */
export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 读毫秒时间戳；非有限数退回 0，时间戳 0 本身没有现实语义，可安全当「无时间」。
 *
 * @param value - 待读取的任意字段值；仅有限数值被接受。
 * @returns 合法毫秒时间戳，非法输入退回 0（哨兵值，不代表真实时间）。
 */
export function readMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 读耗时毫秒；非法值返回 null——这里不能像 `readMs` 那样退回 0，因为 0 毫秒是合法耗时。
 *
 * @param value - 待读取的任意字段值；仅有限数值被接受。
 * @returns 合法耗时毫秒数；非法或缺失时为 null，与 0 区分。
 */
export function readDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * sections 载荷可能是数组以外的脏数据；非数组按无 sections 处理，非对象段由守卫剔除。
 *
 * @param message - 持久化的展示消息；只读其 `sections` 字段，不改写消息本身。
 * @returns 过滤后的段数组；`sections` 非数组时返回 null，与「空数组」区分（前者走旧格式回落）。
 */
export function readSections(message: DisplayMessage): readonly SectionLike[] | null {
  const sections: unknown = message.sections
  if (!Array.isArray(sections)) return null
  // Array.isArray 把 unknown 收窄为 any[]，逐元素用对象守卫过滤（不做类型断言）
  const out: Record<string, unknown>[] = []
  for (const item of sections) {
    if (isRecord(item)) out.push(item)
  }
  return out
}

/**
 * reason 段的思考文本 = items[].content 顺序拼接。
 *
 * @param section - 宽松载荷里的一个 reason 段；items 非数组或元素非法时按空缺跳过。
 * @returns 以换行拼接的思考文本；无可用片段时为空串，不抛错。
 */
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

/**
 * 行摘要取首行，超长截断。
 *
 * @param text - 原始文本，可能含多行；空文本会得到空串。
 * @returns 首行摘要；超过 60 字符时以省略号截断，只作展示，不用于持久化。
 */
export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/**
 * 会话标题：首条用户消息前 30 字符。
 *
 * @param messages - 会话的展示消息序列，按时间先后排列；只在其中找第一条用户消息。
 * @returns 标题字符串；没有可用的用户消息时为空串，由 DTO 层决定是否回落占位文案。
 */
export function extractTitle(messages: readonly DisplayMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || message.content === undefined) continue
    const characters = Array.from(message.content)
    return characters.length > 30 ? `${characters.slice(0, 30).join('')}...` : message.content
  }
  return ''
}
