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

const RECORD_KINDS = new Set(['user', 'call', 'tool', 'subagent', 'turn-end', 'session-end'])
const RECORD_STATUSES = new Set(['success', 'error', 'interrupt', 'incomplete'])
/** 单次尝试只有成/败两态：挂起与打断是**调用级**状态，不属于某一次 HTTP 尝试。 */
const ATTEMPT_STATUSES = new Set(['success', 'error'])
const END_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'exhausted',
  'interrupt',
  'crashed',
])
const COMPACTION_STATUSES = new Set(['success', 'failed', 'interrupted'])

function isTokenUsage(value: unknown): value is TrajectoryTokenUsageDto {
  return (
    isRecord(value) &&
    isNumber(value['input']) &&
    isNumber(value['output']) &&
    (value['cache'] === null || isNumber(value['cache']))
  )
}

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

function isEndState(value: unknown): value is TrajectoryEndStateDto {
  return (
    isRecord(value) &&
    isString(value['state']) &&
    END_STATES.has(value['state']) &&
    isNumber(value['at'])
  )
}

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

/** 会话轨迹响应的运行时校验（前端响应 decoder 与契约测试共用）。 */
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
