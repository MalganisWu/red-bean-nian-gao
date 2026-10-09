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

export const chatMessageSchema: z.ZodType<ChatMessageDto> = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
})

export const chatRequestSchema: z.ZodType<ChatRequestDto> = z.object({
  messages: z.array(chatMessageSchema).min(1),
  session_id: z.string().min(1).optional(),
  agent_id: z.string().optional(),
})

export const cancelRequestSchema: z.ZodType<CancelRequestDto> = z.object({
  request_id: z.string().min(1),
})

export const questionAnswerSchema = z.object({
  kind: z.enum(['option', 'multi', 'custom', 'skip']),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
})

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

export function isQuestionAnswer(value: unknown): value is QuestionAnswerDto {
  if (!isRecord(value)) return false
  if (!['option', 'multi', 'custom', 'skip'].includes(String(value['kind']))) return false
  return (
    isOptional(value['value'], isString) &&
    isOptional(value['values'], (items): items is string[] => isArrayOf(items, isString))
  )
}

export function isStartEvent(value: unknown): value is StartEventDto {
  return (
    isRecord(value) &&
    isString(value['request_id']) &&
    isString(value['session_id']) &&
    isString(value['trace_id'])
  )
}

export function isTokenEvent(value: unknown): value is TokenEventDto {
  return isRecord(value) && isString(value['content'])
}

export function isStatusEvent(value: unknown): value is StatusEventDto {
  return (
    isRecord(value) &&
    isString(value['content']) &&
    isOptional(value['code'], isString) &&
    isOptional(value['attempt'], isNumber) &&
    isOptional(value['max_attempts'], isNumber)
  )
}

export function isReasonEvent(value: unknown): value is ReasonEventDto {
  return (
    isRecord(value) &&
    isString(value['content']) &&
    isNumber(value['step']) &&
    isNumber(value['timestamp'])
  )
}

export function isToolStartEvent(value: unknown): value is ToolStartEventDto {
  return (
    isRecord(value) &&
    isString(value['tool_name']) &&
    isString(value['call_id']) &&
    (value['params'] === null || isRecord(value['params']))
  )
}

export function isToolResultEvent(value: unknown): value is ToolResultEventDto {
  return (
    isRecord(value) &&
    isString(value['tool_name']) &&
    isString(value['call_id']) &&
    isString(value['content']) &&
    isOptional(value['error'], isString)
  )
}

export function isErrorEvent(value: unknown): value is ErrorEventDto {
  return isRecord(value) && isNumber(value['code']) && isString(value['message'])
}

export function isDoneEvent(value: unknown): value is DoneEventDto {
  return isRecord(value) && isNumber(value['tokens_used']) && isString(value['session_id'])
}

export function isHeartbeatEvent(value: unknown): value is HeartbeatEventDto {
  return isRecord(value) && isNumber(value['timestamp'])
}

export function isCompactionEvent(value: unknown): value is CompactionEventDto {
  return (
    isRecord(value) &&
    ['auto', 'manual'].includes(String(value['trigger'])) &&
    isNumber(value['pre_tokens']) &&
    isNumber(value['post_tokens']) &&
    isNumber(value['messages_summarized'])
  )
}

export function isCardEvent(value: unknown): value is CardEventDto {
  return (
    isRecord(value) &&
    isString(value['interaction_id']) &&
    ['pending', 'answered', 'refused'].includes(String(value['status'])) &&
    isArrayOf(value['questions'], isQuestion)
  )
}

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
