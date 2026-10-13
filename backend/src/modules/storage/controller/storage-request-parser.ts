import { objectPathSchema, presignRequestSchema } from '@red-bean/api-contract'
import { validationError } from '../../../shared/http/error-mapper.js'
import { optionalField } from '../../../shared/object/optional-field.js'

/**
 * 解析通配路径参数里的对象 key；缺失或非法一律 400。
 *
 * 通配段（Fastify splat）允许含斜杠，key 的合法性只能靠 Schema 判定，不能按普通路径参数处理；
 * 原始值不可信，先过 Schema 再取 `'*'` 字段。归属与越权判断不在这里，交给应用层。
 *
 * @param value - 未经信任的路径参数对象（来自 `request.params`）；必须是含 `*` 的合法形状
 * @returns 校验通过的对象 key 原文，尚未做归属前缀校验
 */
export function parseObjectPath(value: unknown): string {
  const parsed = objectPathSchema.safeParse(value)
  if (!parsed.success) throw validationError('对象 key 非法')
  return parsed.data['*']
}

/**
 * 解析预签名请求体；`expiresSeconds` 缺省即不写该键，由应用层决定默认有效期。
 *
 * 只保证形状合法：是否超出有效期上限属于业务策略，由应用层拒绝，避免把策略耦合进解析层。
 * 原始值不可信，先过 Schema 再逐字段取出。
 *
 * @param value - 未经信任的请求体原始值；缺 `key` 即 400，`expires` 非法由 Schema 拦截
 * @returns 归一化后的预签名请求；`expiresSeconds` 缺省表示「用应用层默认值」
 */
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
