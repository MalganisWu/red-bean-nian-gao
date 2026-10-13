import { isDeepStrictEqual } from 'node:util'

import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import { toAgentJsonValue } from '../../serialization/json-value-normalizer.js'
import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { AnswerMarker } from '../model/session.js'

/**
 * 中断工具调用的占位结果：缺 tool result 的 tool call 会让模型上下文非法，
 * 补一条显式错误结果让历史保持可继续。文案沿用与 OpenAI 兼容协议的既有英文，
 * 它只进模型上下文、不进用户可见界面。
 */
const INTERRUPTED_TOOL_RESULT = '{"error":"tool call interrupted, result unavailable"}'

/** 从展示 section 里读出的卡片状态；`answers` 只在已作答的卡片上出现。 */
export interface AskCardData {
  /** 卡片对应的交互标识；与 ask 工具调用 id 一致，用于把作答匹配回这张卡。 */
  readonly interactionId: string
  /** 卡片当前状态；pending 表示尚未处理，answered / refused 表示已处理过。 */
  readonly status: string
  /** 提问工具的原始问题载荷；作答回传时原样带回给模型，不要重写。 */
  readonly questions: AgentJsonValue
  /** 用户已给出的答案；只在已作答的卡片上出现，pending 与拒答均缺省。 */
  readonly answers?: AgentJsonValue
}

/**
 * 从持久化展示 section 中移除造成挂起的提问工具。
 * 非法 section 数据原样返回，避免仅展示层的解析失败擦除会话历史。
 *
 * @param sections - 展示 section 数组；非数组时原样返回，不做兜底构造。
 * @param callId - 要剔除的提问工具 call id；只匹配 tool_group 内的同名调用。
 * @returns 过滤后的新数组；整组工具被剔空时该 section 一并移除。
 */
export function filterAskToolGroup(sections: unknown, callId: string): unknown {
  if (!Array.isArray(sections)) return sections

  const filtered: unknown[] = []
  for (const section of sections) {
    if (!isRecord(section) || section['type'] !== 'tool_group') {
      filtered.push(section)
      continue
    }

    const tools = section['tools']
    if (!Array.isArray(tools)) {
      filtered.push(section)
      continue
    }

    const remaining = tools.filter((tool): boolean => !isRecord(tool) || tool['call_id'] !== callId)
    if (remaining.length > 0) filtered.push({ ...section, tools: remaining })
  }
  return filtered
}

/**
 * 修复被中断的工具批次，同时保留刻意悬空、等待后续 resume 请求完成的 interrupt 调用。
 *
 * @param messages - 从 buffer 恢复出的增量消息，可能缺 tool result。
 * @param interruptCallId - 本次要保留悬空的 interrupt 调用 id；缺省空串表示没有刻意悬空的调用。
 * @returns 补齐了中断 tool result 的新消息数组；空输入直接返回空数组。
 */
export function validateAndFix(
  messages: readonly AgentMessage[],
  interruptCallId = ''
): AgentMessage[] {
  if (messages.length === 0) return []

  const completed = new Set<string>()
  const orderedCalls: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (!orderedCalls.includes(call.id)) orderedCalls.push(call.id)
      }
    } else if (message.role === 'tool' && message.toolCallId !== undefined) {
      completed.add(message.toolCallId)
    }
  }

  const repaired = [...messages]
  for (const callId of orderedCalls) {
    if (completed.has(callId) || callId === interruptCallId) continue
    repaired.push({
      role: 'tool',
      content: INTERRUPTED_TOOL_RESULT,
      toolCallId: callId,
    })
  }
  return repaired
}

/**
 * 历史里是否还存在 pending 卡片；跨全部消息扫描，只要有一张未处理就为真。
 *
 * @param messages - 会话的展示消息历史。
 * @returns 存在任一 pending 卡片时为真；调用方据此拒绝发起新一轮运行。
 */
export function hasPendingCard(messages: readonly DisplayMessage[]): boolean {
  return messages.some((message): boolean =>
    sectionsFrom(message).some((section): boolean => cardFromSection(section)?.status === 'pending')
  )
}

/**
 * 找一张**仍处于 pending** 的卡片。
 * 卡片存在但已 answered/refused 时返回 undefined，与「根本没这张卡」走同一条分支——
 * 调用方据此判定「这个交互已经处理过了」，从而把重复的应答请求挡掉。
 *
 * @param messages - 会话的展示消息历史。
 * @param interactionId - 目标交互标识；只认这一张卡片的当前状态。
 * @returns pending 状态的卡片数据；已作答/拒答或压根不存在时均为 undefined。
 */
export function findPendingCard(
  messages: readonly DisplayMessage[],
  interactionId: string
): AskCardData | undefined {
  for (const message of messages) {
    for (const section of sectionsFrom(message)) {
      const card = cardFromSection(section)
      if (card?.interactionId === interactionId) {
        return card.status === 'pending' ? card : undefined
      }
    }
  }
  return undefined
}

/**
 * 把用户作答转成 ask 工具的返回值。
 * 两条分支给出的是**语义不同的载荷**：正常作答回传原问题与答案；拒答则给一段明确要求
 * 模型不要重复追问的文案——只回一个空的 answers 会被模型理解成「用户还没答」，从而再问一遍。
 *
 * @param card - 被作答的卡片；正常作答分支会把它的 `questions` 原样回传。
 * @param marker - 用户的作答标记；`refused` 为真时走拒答分支，忽略答案内容。
 * @returns 序列化后的工具返回值 JSON 串。
 */
export function buildAnswerToolResult(card: AskCardData, marker: AnswerMarker): string {
  if (marker.refused) {
    return JSON.stringify({
      status: 'refused',
      message:
        '用户拒绝回答本次询问，未选择任何选项。请尊重用户意愿，不要重复追问，基于已有信息继续处理或说明无法继续。',
    })
  }
  return JSON.stringify({
    status: 'answered',
    questions: card.questions,
    answers: toAgentJsonValue(marker.answers),
  })
}

/**
 * 断言 D2 不变量：发起 ask 之后、resume 之前，历史里不得再出现 user 或 assistant 消息。
 *
 * 破坏它意味着有人绕过卡片回答路径继续推进了会话——那样 resume 时补进来的
 * tool 结果会落在一条早已过期的上下文里，模型看到的是「问题之后已经聊过别的」的错乱历史。
 * 这里刻意抛错而不是修补：这类结构损坏无法可靠地自动修复，早点暴露比留下一个语义错乱的历史强。
 *
 * @param messages - 待校验的 Agent 消息历史。
 * @param interactionId - 目标 ask 调用 id；历史里找不到它同样视为不变量被破坏。
 */
export function assertAskIsLast(messages: readonly AgentMessage[], interactionId: string): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    if (!(message.toolCalls ?? []).some((call): boolean => call.id === interactionId)) continue

    for (const later of messages.slice(index + 1)) {
      if (later.role === 'user' || later.role === 'assistant') {
        throw new Error(`断言失败：ask 后夹了 ${later.role} 消息，D2 不变量被破坏`)
      }
    }
    return
  }
  throw new Error(`断言失败：未找到 interaction_id ${interactionId} 对应的 ask tool_call`)
}

/**
 * 把作答写回卡片所在 section（状态置 answered 或 refused）；未命中卡片的消息原样返回。
 *
 * @param messages - 会话的展示消息历史。
 * @param marker - 用户作答标记；决定把卡片置为 `answered` 还是 `refused`。
 * @returns 新的消息数组；只有命中的那条消息被复制改写，其余保持同一引用。
 */
export function resolveCard(
  messages: readonly DisplayMessage[],
  marker: AnswerMarker
): DisplayMessage[] {
  return messages.map((message): DisplayMessage => resolveCardInMessage(message, marker))
}

/**
 * 处理单条消息：无 section 或未命中卡片时原样返回，命中时重写该 section 的卡片状态。
 *
 * @param message - 待处理的展示消息。
 * @param marker - 用户作答标记，决定把卡片置为 answered 还是 refused。
 * @returns 命中时是改写后的新消息；未命中时返回同一引用，未涉及的消息不产生多余拷贝。
 */
function resolveCardInMessage(message: DisplayMessage, marker: AnswerMarker): DisplayMessage {
  const sections = sectionsFrom(message)
  if (sections.length === 0) return message
  let changed = false

  /** 重写单个 section 的卡片状态：未命中原样返回，命中则复制并置位 `changed`。 */
  function answerSection(section: AgentJsonValue): AgentJsonValue {
    const card = cardFromSection(section)
    if (card?.interactionId !== marker.interactionId || !isJsonObject(section)) return section
    const rawCard = section['card']
    if (!isJsonObject(rawCard)) return section
    changed = true
    const resolved: AgentJsonObject = marker.refused
      ? { ...rawCard, status: 'refused' }
      : { ...rawCard, status: 'answered', answers: toAgentJsonValue(marker.answers) }
    return { ...section, card: resolved }
  }

  const updated = sections.map((section): AgentJsonValue => answerSection(section))
  return changed ? { ...message, sections: updated } : message
}

/**
 * 把 resume 之后产生的展示 section 插到卡片所在的位置（卡片之后、原后续之前），
 * 而不是简单追加到末尾——这样前端渲染出来的顺序与用户实际经历的时序一致。
 *
 * `merged` 标志保证只插一次：卡片只应出现一次，但万一历史里有重复，
 * 反复插入会把同一段内容复制多份。
 *
 * @param messages - 卡片所在的既有展示消息历史。
 * @param interactionId - 目标卡片标识，决定插在哪条消息的哪个位置。
 * @param continuationMessages - resume 之后产生的展示消息；section 会被取出插入卡片之后。
 * @returns 合并后的新消息数组；continuation 为空时返回原历史的浅拷贝。
 */
export function mergeContinuation(
  messages: readonly DisplayMessage[],
  interactionId: string,
  continuationMessages: readonly DisplayMessage[]
): DisplayMessage[] {
  const continuation = continuationMessages.flatMap((message): AgentJsonValue[] =>
    sectionsFrom(message)
  )
  if (continuation.length === 0) return [...messages]

  let merged = false

  /**
   * 在当前消息里插入 continuation：只插一次（`merged` 置位后其余消息原样返回），
   * 未找到卡片 section 的消息也原样返回。
   */
  function mergeIntoMessage(message: DisplayMessage): DisplayMessage {
    if (merged) return message
    const sections = sectionsFrom(message)
    const cardIndex = sections.findIndex(
      (section): boolean => cardFromSection(section)?.interactionId === interactionId
    )
    if (cardIndex < 0) return message
    merged = true
    return {
      ...message,
      sections: [
        ...sections.slice(0, cardIndex + 1),
        ...continuation,
        ...sections.slice(cardIndex + 1),
      ],
    }
  }

  return messages.map((message): DisplayMessage => mergeIntoMessage(message))
}

/**
 * 拼接两段历史时去掉重叠部分：从最长的可能重叠长度往下试，
 * 第一个匹配上的就是真实重叠。
 *
 * 场景是崩溃恢复——checkpoint 里的已有消息与 buffer 里的增量消息在边界处会有重叠
 * （同一条消息既进了 checkpoint 又留在 buffer）。不识别的话，恢复后模型会看到重复的对话轮次。
 * 用深比较而不是按 id 匹配：`AgentMessage` 没有稳定主键，内容相同即视为同一条。
 *
 * @param existing - 已提交进 checkpoint 的历史，作为拼接的左段。
 * @param recovered - 从 buffer 恢复出的增量消息，作为右段。
 * @returns 去重后的新数组；没有重叠时等价于直接拼接两段。
 */
export function appendWithoutOverlap(
  existing: readonly AgentMessage[],
  recovered: readonly AgentMessage[]
): AgentMessage[] {
  const maximum = Math.min(existing.length, recovered.length)
  for (let overlap = maximum; overlap > 0; overlap -= 1) {
    if (isDeepStrictEqual(existing.slice(existing.length - overlap), recovered.slice(0, overlap))) {
      return [...existing, ...recovered.slice(overlap)]
    }
  }
  return [...existing, ...recovered]
}

/**
 * 读取展示消息上的 sections；持久化的是宽松 JSON，它可能缺失或不是数组，
 * 此时返回空数组而不抛错，让投影与卡片查询对脏数据保持容错。
 *
 * @param message - 会话的展示消息。
 * @returns section 数组；缺失或非数组时为空数组。
 */
function sectionsFrom(message: DisplayMessage): AgentJsonValue[] {
  return Array.isArray(message.sections) ? message.sections : []
}

/**
 * 从 section 里读出卡片数据；不是 card 段、或关键字段类型不符时返回 undefined。
 * status 原样透出，pending / answered / refused 的判定交给调用方。
 *
 * @param section - 展示消息里的单个 section。
 * @returns 卡片数据；不是合法卡片段时为 undefined。
 */
function cardFromSection(section: AgentJsonValue): AskCardData | undefined {
  if (!isJsonObject(section) || section['type'] !== 'card') return undefined
  const card = section['card']
  if (!isJsonObject(card)) return undefined
  const interactionId = card['interaction_id']
  const status = card['status']
  const questions = card['questions']
  if (typeof interactionId !== 'string' || typeof status !== 'string' || questions === undefined) {
    return undefined
  }
  const answers = card['answers']
  return answers === undefined
    ? { interactionId, status, questions }
    : { interactionId, status, questions, answers }
}

/**
 * 判定未知值是否为普通 JSON 对象，用于把宽松持久化数据收窄成 `AgentJsonObject`。
 *
 * @param value - 待判定的未知值。
 * @returns 是对象时为 true，并把类型收窄为 `AgentJsonObject`。
 */
function isJsonObject(value: unknown): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判定未知值是否为普通对象，用于把宽松持久化数据收窄成可按下标访问的记录。
 *
 * @param value - 待判定的未知值。
 * @returns 是对象时为 true，并把类型收窄为 `Record<string, unknown>`。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
