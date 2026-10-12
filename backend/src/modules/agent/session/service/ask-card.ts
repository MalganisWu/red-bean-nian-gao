import { isDeepStrictEqual } from 'node:util'

import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import { toAgentJsonValue } from '../../serialization/json-value-normalizer.js'
import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { AnswerMarker } from '../model/session.js'

const INTERRUPTED_TOOL_RESULT = '{"error":"tool call interrupted, result unavailable"}'

export interface AskCardData {
  readonly interactionId: string
  readonly status: string
  readonly questions: AgentJsonValue
  readonly answers?: AgentJsonValue
}

/**
 * 从持久化展示 section 中移除造成挂起的提问工具。
 * 非法 section 数据原样返回，避免仅展示层的解析失败擦除会话历史。
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

export function hasPendingCard(messages: readonly DisplayMessage[]): boolean {
  return messages.some((message): boolean =>
    sectionsFrom(message).some((section): boolean => cardFromSection(section)?.status === 'pending')
  )
}

/**
 * 找一张**仍处于 pending** 的卡片。
 * 卡片存在但已 answered/refused 时返回 undefined，与「根本没这张卡」走同一条分支——
 * 调用方据此判定「这个交互已经处理过了」，从而把重复的应答请求挡掉。
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

export function resolveCard(
  messages: readonly DisplayMessage[],
  marker: AnswerMarker
): DisplayMessage[] {
  return messages.map((message): DisplayMessage => {
    const sections = sectionsFrom(message)
    if (sections.length === 0) return message
    let changed = false
    const updated = sections.map((section): AgentJsonValue => {
      const card = cardFromSection(section)
      if (card?.interactionId !== marker.interactionId || !isJsonObject(section)) return section
      const rawCard = section['card']
      if (!isJsonObject(rawCard)) return section
      changed = true
      const resolved: AgentJsonObject = marker.refused
        ? { ...rawCard, status: 'refused' }
        : { ...rawCard, status: 'answered', answers: toAgentJsonValue(marker.answers) }
      return { ...section, card: resolved }
    })
    return changed ? { ...message, sections: updated } : message
  })
}

/**
 * 把 resume 之后产生的展示 section 插到卡片所在的位置（卡片之后、原后续之前），
 * 而不是简单追加到末尾——这样前端渲染出来的顺序与用户实际经历的时序一致。
 *
 * `merged` 标志保证只插一次：卡片只应出现一次，但万一历史里有重复，
 * 反复插入会把同一段内容复制多份。
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
  return messages.map((message): DisplayMessage => {
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
  })
}

/**
 * 拼接两段历史时去掉重叠部分：从最长的可能重叠长度往下试，
 * 第一个匹配上的就是真实重叠。
 *
 * 场景是崩溃恢复——checkpoint 里的已有消息与 buffer 里的增量消息在边界处会有重叠
 * （同一条消息既进了 checkpoint 又留在 buffer）。不识别的话，恢复后模型会看到重复的对话轮次。
 * 用深比较而不是按 id 匹配：`AgentMessage` 没有稳定主键，内容相同即视为同一条。
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

function sectionsFrom(message: DisplayMessage): AgentJsonValue[] {
  return Array.isArray(message.sections) ? message.sections : []
}

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

function isJsonObject(value: unknown): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
