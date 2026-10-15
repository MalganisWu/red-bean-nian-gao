// 对话链路的 wire 契约：请求体用 zod schema 校验，SSE 帧用类型守卫校验。
//
// 两者分工明确：schema 面向「客户端能提交什么」，守卫面向「服务端发来的这一帧形状对不对」。
// 守卫只做结构判定，不承担业务语义校验（如 status 码是否已登记），
// 因此非法业务取值不会在这里被拦下——它们由消费方的分支处理。
import type {
  AnswerRequestDto,
  CancelRequestDto,
  CardEventDto,
  ChatMessageDto,
  ChatRequestDto,
  CompactionEventDto,
  DoneEventDto,
  ErrorEventDto,
  HeartbeatEventDto,
  QuestionAnswerDto,
  QuestionDto,
  ReasonEventDto,
  StartEventDto,
  StatusEventDto,
  SubAgentEnvelopeDto,
  TokenEventDto,
  ToolResultEventDto,
  ToolStartEventDto,
} from './dto.js'
import { z } from 'zod'
import { isArrayOf, isNumber, isOptional, isRecord, isString } from '../common/schema.js'

/** 一条对话消息；`content` 不允许为空串——空消息没有语义，挡在契约层比让下游各自判空好。 */
export const chatMessageSchema: z.ZodType<ChatMessageDto> = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
})

/** 发起对话的请求体；`messages` 至少一条，`session_id` / `agent_id` 缺省时由服务端补默认值。 */
export const chatRequestSchema: z.ZodType<ChatRequestDto> = z.object({
  messages: z.array(chatMessageSchema).min(1),
  session_id: z.string().min(1).optional(),
  agent_id: z.string().optional(),
})

/** 取消运行请求体；只需 `request_id`。 */
export const cancelRequestSchema: z.ZodType<CancelRequestDto> = z.object({
  request_id: z.string().min(1),
})

/** 单个问题的作答；`value` 与 `values` 都是可选的，用哪个由 `kind` 决定。 */
export const questionAnswerSchema = z.object({
  kind: z.enum(['option', 'multi', 'custom', 'skip']),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
})

/**
 * 答题请求体。
 * `answers` 与 `refused` 至少要有一个：「拒答」必须显式表达，
 * 否则两者皆空会被理解成「还没答」，卡片状态也就无从推进。
 */
export const answerRequestSchema: z.ZodType<AnswerRequestDto> = z
  .object({
    session_id: z.string().min(1),
    interaction_id: z.string().min(1),
    agent_id: z.string().optional(),
    answers: z.record(z.string(), questionAnswerSchema).optional(),
    refused: z.boolean().optional(),
  })
  .refine(
    (value): boolean => value.refused === true || value.answers !== undefined,
    'answers or refused is required'
  )

/**
 * 卡片问题的形状守卫；`id` 与 `text` 必需，说明、选项与选择方式可选。
 * @param value - 待判定的一帧/一项；缺 `id` 或 `text` 直接判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isQuestion(value: unknown): value is QuestionDto {
  if (!isRecord(value) || !isString(value['id']) || !isString(value['text'])) return false
  return (
    isOptional(value['description'], isString) &&
    isOptional(value['options'], (items): items is string[] => isArrayOf(items, isString)) &&
    isOptional(value['select'], (select): select is 'single' | 'multi' =>
      ['single', 'multi'].includes(String(select))
    )
  )
}

/**
 * 作答的形状守卫；`kind` 必须是四个已知取值之一，未知取值一律判假。
 * @param value - 待判定的作答对象；`kind` 必须是四个已知取值之一。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isQuestionAnswer(value: unknown): value is QuestionAnswerDto {
  if (!isRecord(value)) return false
  if (!['option', 'multi', 'custom', 'skip'].includes(String(value['kind']))) return false
  return (
    isOptional(value['value'], isString) &&
    isOptional(value['values'], (items): items is string[] => isArrayOf(items, isString))
  )
}

/**
 * `start` 帧：request_id / session_id / trace_id 三者齐备。
 * @param value - 待判定的一帧；三个 id 字段缺一即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isStartEvent(value: unknown): value is StartEventDto {
  return (
    isRecord(value) &&
    isString(value['request_id']) &&
    isString(value['session_id']) &&
    isString(value['trace_id'])
  )
}

/**
 * `token` 帧：只有正文增量，`content` 是唯一必需字段。
 * @param value - 待判定的一帧；`content` 非字符串即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isTokenEvent(value: unknown): value is TokenEventDto {
  return isRecord(value) && isString(value['content'])
}

/**
 * `status` 帧：`content` 必需，`code` / `attempt` / `max_attempts` 可选。
 * @param value - 待判定的一帧；`content` 非字符串即判假，可选字段给了就必须合法。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isStatusEvent(value: unknown): value is StatusEventDto {
  return (
    isRecord(value) &&
    isString(value['content']) &&
    isOptional(value['code'], isString) &&
    isOptional(value['attempt'], isNumber) &&
    isOptional(value['max_attempts'], isNumber)
  )
}

/**
 * `reason` 帧：content 与 step / timestamp 都必需。
 * @param value - 待判定的一帧；三个必需字段缺一即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isReasonEvent(value: unknown): value is ReasonEventDto {
  return (
    isRecord(value) &&
    isString(value['content']) &&
    isNumber(value['step']) &&
    isNumber(value['timestamp'])
  )
}

/**
 * `tool_start` 帧：`params` 允许为 null（参数不是可解析的 JSON 对象时）。
 * @param value - 待判定的一帧；`params` 为 null 或对象皆可，其余判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isToolStartEvent(value: unknown): value is ToolStartEventDto {
  return (
    isRecord(value) &&
    isString(value['tool_name']) &&
    isString(value['call_id']) &&
    (value['params'] === null || isRecord(value['params']))
  )
}

/**
 * `tool_result` 帧：`error` 可选，有值即表示这次工具调用失败。
 * @param value - 待判定的一帧；`error` 给了就必须是字符串，其余必填字段缺一即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isToolResultEvent(value: unknown): value is ToolResultEventDto {
  return (
    isRecord(value) &&
    isString(value['tool_name']) &&
    isString(value['call_id']) &&
    isString(value['content']) &&
    isOptional(value['error'], isString)
  )
}

/**
 * `error` 帧：业务码 + 对外文案。
 * @param value - 待判定的一帧；`code` 必须是数字、`message` 必须是字符串。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isErrorEvent(value: unknown): value is ErrorEventDto {
  return isRecord(value) && isNumber(value['code']) && isString(value['message'])
}

/**
 * `done` 帧：收尾帧，带 token 用量与会话 ID。
 * @param value - 待判定的一帧；`tokens_used` 非数字或 `session_id` 非字符串即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isDoneEvent(value: unknown): value is DoneEventDto {
  return isRecord(value) && isNumber(value['tokens_used']) && isString(value['session_id'])
}

/**
 * `heartbeat` 帧：只有时间戳。
 * @param value - 待判定的一帧；`timestamp` 非数字即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isHeartbeatEvent(value: unknown): value is HeartbeatEventDto {
  return isRecord(value) && isNumber(value['timestamp'])
}

/**
 * `compaction` 帧：`trigger` 必须是 auto / manual 之一，三个 token 计数均为数字。
 * @param value - 待判定的一帧；`trigger` 取值未知或 token 计数非数字即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isCompactionEvent(value: unknown): value is CompactionEventDto {
  return (
    isRecord(value) &&
    ['auto', 'manual'].includes(String(value['trigger'])) &&
    isNumber(value['pre_tokens']) &&
    isNumber(value['post_tokens']) &&
    isNumber(value['messages_summarized'])
  )
}

/**
 * `card` 帧：`status` 限定 pending / answered / refused 三态，questions 逐项过 `isQuestion`。
 * @param value - 待判定的一帧；`status` 取值未知或任一 question 不合法即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isCardEvent(value: unknown): value is CardEventDto {
  return (
    isRecord(value) &&
    isString(value['interaction_id']) &&
    ['pending', 'answered', 'refused'].includes(String(value['status'])) &&
    isArrayOf(value['questions'], isQuestion)
  )
}

/**
 * `agent_event` 信封：只校验外层标识与「有 event 字段」，内层载荷由调用方按 event_type 继续判。
 * @param value - 待判定的一帧；只查外层标识字段与 `event` 键是否存在，不深入内层载荷。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isSubAgentEnvelope(value: unknown): value is SubAgentEnvelopeDto {
  return (
    isRecord(value) &&
    isString(value['agent_id']) &&
    isString(value['agent_name']) &&
    isString(value['execution_id']) &&
    isString(value['parent_call_id']) &&
    isString(value['event_type']) &&
    'event' in value
  )
}
