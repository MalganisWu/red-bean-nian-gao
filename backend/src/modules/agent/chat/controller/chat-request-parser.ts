import {
  answerRequestSchema,
  cancelRequestSchema,
  chatRequestSchema,
  type AnswerRequestDto,
  type CancelRequestDto,
  type ChatRequestDto,
} from '@red-bean/api-contract'
import { validationError } from '../../../../shared/http/error-mapper.js'

/**
 * 校验来自 HTTP 边界的新建或续聊请求。
 *
 * @param value - 路由解包出的请求体，形状与内容都不可信，一律经共享契约的 Schema 校验。
 * @returns 通过校验的新建/续聊 DTO；不满足 Schema 时抛出 400，不返回半成品。
 */
export function parseChatRequestDto(value: unknown): ChatRequestDto {
  const parsed = chatRequestSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/**
 * 校验来自 HTTP 边界的取消请求。
 *
 * @param value - 路由解包出的请求体，形状与内容都不可信，一律经共享契约的 Schema 校验。
 * @returns 通过校验的取消 DTO；不满足 Schema 时抛出 400。
 */
export function parseCancelRequestDto(value: unknown): CancelRequestDto {
  const parsed = cancelRequestSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/**
 * 校验来自 HTTP 边界的人工回答请求。
 *
 * @param value - 路由解包出的请求体，形状与内容都不可信，一律经共享契约的 Schema 校验。
 * @returns 通过校验的回答 DTO；不满足 Schema 时抛出 400。
 */
export function parseAnswerRequestDto(value: unknown): AnswerRequestDto {
  const parsed = answerRequestSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}
