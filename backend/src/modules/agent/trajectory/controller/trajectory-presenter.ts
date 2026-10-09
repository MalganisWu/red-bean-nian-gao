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

function toEndStateDto(end: TrajectoryEndState): TrajectoryEndStateDto {
  return {
    state: end.state,
    at: end.at,
    ...optionalField('note', end.note),
  }
}

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
