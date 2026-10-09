import {
  answerRequestSchema,
  cancelRequestSchema,
  chatRequestSchema,
  type AnswerRequestDto,
  type CancelRequestDto,
  type ChatRequestDto,
} from '@red-bean/api-contract'
import { validationError } from '../../../../shared/http/error-mapper.js'

/** 校验来自 HTTP 边界的新建或续聊请求。 */
export function parseChatRequestDto(value: unknown): ChatRequestDto {
  const parsed = chatRequestSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/** 校验来自 HTTP 边界的取消请求。 */
export function parseCancelRequestDto(value: unknown): CancelRequestDto {
  const parsed = cancelRequestSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}

/** 校验来自 HTTP 边界的人工回答请求。 */
export function parseAnswerRequestDto(value: unknown): AnswerRequestDto {
  const parsed = answerRequestSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误')
  return parsed.data
}
