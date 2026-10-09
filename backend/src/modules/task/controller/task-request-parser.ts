import {
  executionParamsSchema,
  executionViewStatePatchSchema,
  taskParamsSchema,
  updateTaskSchema,
  type ExecutionViewStatePatchDto,
  type UpdateTaskDto,
} from '@red-bean/api-contract'
import { validationError } from './../../../shared/http/error-mapper.js'

export function parseTaskId(value: unknown): string {
  const parsed = taskParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('任务 ID 不能为空')
  return parsed.data.id
}

export function parseExecutionParams(value: unknown): {
  readonly id: string
  readonly eid: string
} {
  const parsed = executionParamsSchema.safeParse(value)
  if (!parsed.success) throw validationError('任务 ID 和执行 ID 不能为空')
  return parsed.data
}

export function parseUpdateTaskDto(value: unknown): UpdateTaskDto {
  const parsed = updateTaskSchema.safeParse(value)
  if (!parsed.success) throw validationError('请求参数错误：缺少 is_active 参数')
  return parsed.data
}

export function parseExecutionViewStatePatchDto(value: unknown): ExecutionViewStatePatchDto {
  const parsed = executionViewStatePatchSchema.safeParse(value)
  if (!parsed.success) {
    throw validationError('请求至少需要 mark_seen:true 或 collapsed_override')
  }
  return parsed.data
}

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
