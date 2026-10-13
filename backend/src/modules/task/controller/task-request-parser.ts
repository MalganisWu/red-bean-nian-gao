import {
  executionParamsSchema,
  executionViewStatePatchSchema,
  taskParamsSchema,
  updateTaskSchema,
  type ExecutionViewStatePatchDto,
  type UpdateTaskDto,
} from '@red-bean/api-contract'
import { validationError } from './../../../shared/http/error-mapper.js'

/**
 * 校验路径参数里的任务 ID；失败抛 400，zod 的原始报错只作 cause，不进响应体。
 *
 * @param value - 路由解包出的原始路径参数，形状与内容都不可信，一律经 Schema 校验。
 * @returns 通过校验的任务 ID。
 */
export function parseTaskId(value: unknown): string {
  const parsed = taskParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('任务 ID 不能为空')
  return parsed.data.id
}

/**
 * 校验组合路径参数：任务 ID 与执行 ID 必须同时给出。
 *
 * @param value - 路由解包出的原始路径参数；缺任一个 ID 即失败。
 * @returns 通过校验的任务 ID 与执行 ID。
 */
export function parseExecutionParams(value: unknown): {
  readonly id: string
  readonly eid: string
} {
  const parsed = executionParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('任务 ID 和执行 ID 不能为空')
  return parsed.data
}

/**
 * 校验任务更新体；当前可改字段只有 `is_active`，其余字段一律拒绝。
 *
 * @param value - 请求体原始值；未声明 `is_active` 或类型不符即抛 400。
 * @returns 仅含 `is_active` 的更新 DTO。
 */
export function parseUpdateTaskDto(value: unknown): UpdateTaskDto {
  const parsed = updateTaskSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误：缺少 is_active 参数')
  return parsed.data
}

/**
 * 校验已读/折叠偏好的 PATCH 体；两个字段至少要给一个，空对象会被拒。
 *
 * @param value - 请求体原始值；空对象或两者都缺即抛 400。
 * @returns 视图状态补丁 DTO，至少含 `mark_seen` 与 `collapsed_override` 之一。
 */
export function parseExecutionViewStatePatchDto(value: unknown): ExecutionViewStatePatchDto {
  const parsed = executionViewStatePatchSchema.safeParse(value)
  if (!parsed.success) {
    throw validationError('请求至少需要 mark_seen:true 或 collapsed_override')
  }
  return parsed.data
}

/**
 * 解析逗号分隔的执行 ID 列表：去重、去空白，并限 100 个。
 * 上限不是拍脑袋的约束——这批 ID 最终会拼进 `IN (...)`，不设限就等于允许调用方
 * 用一个请求构造出超长查询。
 *
 * @param value - 路由解包出的原始 query；非对象或 `execution_ids` 非字符串时按空列表处理。
 * @returns 去重去空白后的执行 ID 列表；为空或超过 100 个时抛 400。
 */
export function parseExecutionIds(value: unknown): readonly string[] {
  const raw =
    isRecord(value) && typeof value['execution_ids'] === 'string' ? value['execution_ids'] : ''
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((item): string => item.trim())
        .filter(Boolean)
    ),
  ]
  if (ids.length === 0) throw validationError('execution_ids 不能为空')
  if (ids.length > 100) throw validationError('execution_ids 不能超过 100 个')
  return ids
}

/**
 * 解析分页查询：limit 非法或超 100 一律退回 20；游标缺省为空串，表示取首页。
 *
 * @param value - 路由解包出的原始 query，可能不是对象，非对象一律按空查询处理。
 * @returns 规范化后的游标与页大小，二者都不可能是非法值。
 */
export function parseTaskPagination(value: unknown): {
  readonly cursor: string
  readonly limit: number
} {
  const query = isRecord(value) ? value : {}
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : ''
  const parsed = typeof query['limit'] === 'string' ? Number.parseInt(query['limit'], 10) : 20
  const limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20
  return { cursor, limit }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
