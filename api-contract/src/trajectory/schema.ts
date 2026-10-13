import { z } from 'zod'

import type {
  SessionTrajectoryDto,
  TrajectoryCompactionDto,
  TrajectoryEndStateDto,
  TrajectoryAttemptDto,
  TrajectoryRecordDto,
  TrajectoryTokenUsageDto,
} from './dto.js'
import { isArrayOf, isNumber, isRecord, isString } from '../common/schema.js'

/** 路径参数：会话 id。 */
export const trajectoryParamsSchema = z.object({ id: z.string().min(1) })

/** 轨迹记录类型集合；`isRecordDto` 用它挡住未登记的类型取值。 */
const RECORD_KINDS = new Set(['user', 'call', 'tool', 'subagent', 'turn-end', 'session-end'])
/** 记录状态集合；success / error 是执行结果，interrupt / incomplete 是打断类终态。 */
const RECORD_STATUSES = new Set(['success', 'error', 'interrupt', 'incomplete'])
/** 单次尝试只有成/败两态：挂起与打断是**调用级**状态，不属于某一次 HTTP 尝试。 */
const ATTEMPT_STATUSES = new Set(['success', 'error'])
/** 轮次/会话终态集合；按触发者区分，四个近义值不得混用（详见 `TrajectoryEndStateDto`）。 */
const END_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'exhausted',
  'interrupt',
  'crashed',
])
/** 压缩状态集合；三态之外一律拒收。 */
const COMPACTION_STATUSES = new Set(['success', 'failed', 'interrupted'])

/**
 * token 用量守卫；`input` / `output` 必为数字，`cache` 允许为 null（表示未采集）。
 * @param value - 待判定的用量对象；`cache` 为 null 或数字皆可，`input` / `output` 缺一即判假。
 * @returns 形状成立时为 true，否则 false。
 */
function isTokenUsage(value: unknown): value is TrajectoryTokenUsageDto {
  return (
    isRecord(value) &&
    isNumber(value['input']) &&
    isNumber(value['output']) &&
    (value['cache'] === null || isNumber(value['cache']))
  )
}

/**
 * 单次尝试的守卫；`tokens` 可为 null（失败请求），`status` 按尝试级取值域校验。
 * @param value - 待判定的尝试明细；`status` 必须是 `ATTEMPT_STATUSES` 内的取值，`tokens` 可为 null。
 * @returns 形状成立时为 true，否则 false。
 */
function isAttempt(value: unknown): value is TrajectoryAttemptDto {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isNumber(value['seq']) &&
    isString(value['model']) &&
    isString(value['attempt']) &&
    isNumber(value['durationMs']) &&
    (value['tokens'] === null || isTokenUsage(value['tokens'])) &&
    isString(value['status']) &&
    ATTEMPT_STATUSES.has(value['status']) &&
    isNumber(value['at'])
  )
}

/**
 * 轨迹记录的守卫；必填字段之外，`status` / `tokens` / `children` / `attempts` 可选且给了就必须合法。
 * @param value - 待判定的记录；`kind` 与可选的 `status` 必须是已登记取值，`children` 逐条递归校验。
 * @returns 形状成立时为 true，否则 false。
 */
function isRecordDto(value: unknown): value is TrajectoryRecordDto {
  if (!isRecord(value)) return false
  if (!isString(value['id']) || !isNumber(value['seq'])) return false
  if (!isString(value['kind']) || !RECORD_KINDS.has(value['kind'])) return false
  if (!isNumber(value['at']) || !isString(value['summary'])) return false
  if (
    value['status'] !== undefined &&
    !(isString(value['status']) && RECORD_STATUSES.has(value['status']))
  )
    return false
  if (value['tokens'] !== undefined && value['tokens'] !== null && !isTokenUsage(value['tokens']))
    return false
  if (value['children'] !== undefined && !isArrayOf(value['children'], isRecordDto)) return false
  if (value['attempts'] !== undefined && !isArrayOf(value['attempts'], isAttempt)) return false
  return true
}

/**
 * 轮次/会话终态的守卫；`state` 必须是 `END_STATES` 内的取值。
 * @param value - 待判定的终态标记；`state` 取值未知或 `at` 非数字即判假。
 * @returns 形状成立时为 true，否则 false。
 */
function isEndState(value: unknown): value is TrajectoryEndStateDto {
  return (
    isRecord(value) &&
    isString(value['state']) &&
    END_STATES.has(value['state']) &&
    isNumber(value['at'])
  )
}

/**
 * 压缩事件的守卫；`status` 必须是 `COMPACTION_STATUSES` 内的取值，其余字段必为数字。
 * @param value - 待判定的压缩事件；`status` 取值未知或任一计数非数字即判假。
 * @returns 形状成立时为 true，否则 false。
 */
function isCompaction(value: unknown): value is TrajectoryCompactionDto {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isNumber(value['seq']) &&
    isNumber(value['afterTurn']) &&
    isNumber(value['at']) &&
    isNumber(value['durationMs']) &&
    isNumber(value['beforeTokens']) &&
    isNumber(value['afterTokens']) &&
    isNumber(value['messages']) &&
    isString(value['status']) &&
    COMPACTION_STATUSES.has(value['status'])
  )
}

/**
 * 会话轨迹响应的运行时校验（前端响应 decoder 与契约测试共用）。
 * @param value - 待判定的轨迹响应；轮次、压缩、结束态与 token 汇总全部逐层校验，任一不合法即判假。
 * @returns 形状成立时为 true，否则 false（不抛错）。
 */
export function isSessionTrajectory(value: unknown): value is SessionTrajectoryDto {
  if (!isRecord(value)) return false
  if (!isString(value['sessionId']) || !isString(value['title'])) return false
  if (
    !isArrayOf(value['turns'], (t): t is SessionTrajectoryDto['turns'][number] => {
      if (!isRecord(t)) return false
      if (!isNumber(t['turn']) || !isNumber(t['startedAt']) || !isNumber(t['durationMs']))
        return false
      if (!(t['tokens'] === null || isNumber(t['tokens']))) return false
      if (!isArrayOf(t['records'], isRecordDto)) return false
      if (t['endState'] !== undefined && t['endState'] !== null && !isEndState(t['endState']))
        return false
      return true
    })
  )
    return false
  if (
    value['compaction'] !== undefined &&
    value['compaction'] !== null &&
    !isCompaction(value['compaction'])
  )
    return false
  if (
    value['sessionEnd'] !== undefined &&
    value['sessionEnd'] !== null &&
    !isEndState(value['sessionEnd'])
  )
    return false
  if (!(value['totalTokens'] === null || isNumber(value['totalTokens']))) return false
  if (!isNumber(value['subAgentTokens'])) return false
  if (!isNumber(value['activeMs']) || !isNumber(value['spanMs'])) return false
  return true
}
