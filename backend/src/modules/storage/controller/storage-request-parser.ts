import { objectPathSchema, presignRequestSchema } from '@red-bean/api-contract'
import { validationError } from '../../../shared/http/error-mapper.js'
import { optionalField } from '../../../shared/object/optional-field.js'

export function parseObjectPath(value: unknown): string {
  const parsed = objectPathSchema.safeParse(value)
  if (!parsed.success) throw validationError('对象 key 非法')
  return parsed.data['*']
}

export function parsePresignRequest(value: unknown): {
  readonly key: string
  readonly expiresSeconds?: number | undefined
} {
  const parsed = presignRequestSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误：缺少 key 参数')
  return {
    key: parsed.data.key,
    ...optionalField('expiresSeconds', parsed.data.expires),
  }
}
