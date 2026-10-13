import type {
  SessionTrajectoryDto,
  TrajectoryCompactionDto,
  TrajectoryEndStateDto,
  TrajectoryAttemptDto,
  TrajectoryRecordDto,
} from '@red-bean/api-contract'

import type {
  SessionTrajectory,
  TrajectoryCompaction,
  TrajectoryEndState,
  TrajectoryAttempt,
  TrajectoryRecord,
} from '../model/trajectory.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/**
 * 领域轨迹 → wire DTO 的纯映射。显式逐字段拷贝：DTO 是公开契约，
 * 领域模型的内部字段不得随结构共享泄漏到线上响应。
 *
 * @param view - 领域层投影出的会话轨迹，可能带内部专用字段；这里只读取契约覆盖到的部分。
 * @returns wire DTO；`endState`/`compaction` 的 null 或缺省一律归一为 null，前端无需再判 undefined。
 */
export function toSessionTrajectoryDto(view: SessionTrajectory): SessionTrajectoryDto {
  return {
    sessionId: view.sessionId,
    title: view.title,
    turns: view.turns.map((turn) => ({
      turn: turn.turn,
      startedAt: turn.startedAt,
      durationMs: turn.durationMs,
      tokens: turn.tokens,
      records: turn.records.map(toRecordDto),
      endState:
        turn.endState === null || turn.endState === undefined
          ? (turn.endState ?? null)
          : toEndStateDto(turn.endState),
      ...optionalField('note', turn.note),
    })),
    compaction:
      view.compaction === null || view.compaction === undefined
        ? (view.compaction ?? null)
        : toCompactionDto(view.compaction),
    sessionEnd:
      view.sessionEnd === null || view.sessionEnd === undefined
        ? (view.sessionEnd ?? null)
        : toEndStateDto(view.sessionEnd),
    totalTokens: view.totalTokens,
    subAgentTokens: view.subAgentTokens,
    activeMs: view.activeMs,
    spanMs: view.spanMs,
  }
}

/**
 * 把轨迹的结束态映射成 wire DTO；`note` 是内部可选字段，缺失时整字段不出现在响应里。
 *
 * @param end - 领域层的结束态，含运行终止的判定依据与时间点。
 * @returns 只保留契约字段的结束态 DTO。
 */
function toEndStateDto(end: TrajectoryEndState): TrajectoryEndStateDto {
  return {
    state: end.state,
    at: end.at,
    ...optionalField('note', end.note),
  }
}

/**
 * 把一次压缩（compaction）映射成 wire DTO，压缩前后的 token 与消息数一并透出，
 * 供前端还原「这次压缩省了多少」。`strategy` 为可选字段，缺失即不出现。
 *
 * @param c - 领域层的压缩记录。
 * @returns 只含契约字段的压缩 DTO。
 */
function toCompactionDto(c: TrajectoryCompaction): TrajectoryCompactionDto {
  return {
    id: c.id,
    seq: c.seq,
    afterTurn: c.afterTurn,
    at: c.at,
    durationMs: c.durationMs,
    beforeTokens: c.beforeTokens,
    afterTokens: c.afterTokens,
    messages: c.messages,
    status: c.status,
    ...optionalField('strategy', c.strategy),
  }
}

/**
 * 递归把一条轨迹记录映射成 wire DTO。`children`（子代理记录）与 `attempts`（重试记录）
 * 只在存在时展开，其余可选字段交给 `optionalField` 决定是否出现：DTO 里绝不出现 value 为
 * `undefined` 的字段，前端据此可用「字段是否存在」做一次判断。
 *
 * @param r - 领域层的轨迹记录，可能带下钻用的 children/attempts。
 * @returns 只含契约字段的记录 DTO，子记录已递归转换。
 */
function toRecordDto(r: TrajectoryRecord): TrajectoryRecordDto {
  return {
    id: r.id,
    seq: r.seq,
    kind: r.kind,
    at: r.at,
    summary: r.summary,
    ...optionalField('name', r.name),
    ...optionalField('target', r.target),
    ...optionalField('tokens', r.tokens),
    ...optionalField('totalTokens', r.totalTokens),
    ...optionalField('durationMs', r.durationMs),
    ...optionalField('status', r.status),
    ...(r.children === undefined ? {} : { children: r.children.map(toRecordDto) }),
    ...(r.attempts === undefined ? {} : { attempts: r.attempts.map(toAttemptDto) }),
    ...optionalField('waitMs', r.waitMs),
    ...optionalField('thinking', r.thinking),
    ...optionalField('reply', r.reply),
    ...optionalField('params', r.params),
    ...optionalField('result', r.result),
    ...optionalField('model', r.model),
  }
}

/**
 * 把一次尝试（attempt）映射成 wire DTO；`error` 仅在失败尝试上出现，
 * 成功尝试不带该字段，前端无需为空错误串做特判。
 *
 * @param q - 领域层的单次尝试记录，含模型、耗时与 token。
 * @returns 只含契约字段的尝试 DTO。
 */
function toAttemptDto(q: TrajectoryAttempt): TrajectoryAttemptDto {
  return {
    id: q.id,
    seq: q.seq,
    model: q.model,
    attempt: q.attempt,
    durationMs: q.durationMs,
    tokens: q.tokens,
    status: q.status,
    at: q.at,
    ...optionalField('error', q.error),
  }
}
