import type {
  SessionTrajectoryDto,
  TrajectoryCompactionDto,
  TrajectoryEndStateDto,
  TrajectoryRecordDto,
  TrajectoryAttemptDto,
} from '@red-bean/api-contract'

import type {
  TrajectoryCompaction,
  TrajectoryAttempt,
  TrajectoryRecord,
  TrajectorySessionEnd,
  TrajectoryTokenUsage,
  TrajectoryTurn,
  TrajectoryTurnEnd,
} from '@/components/retroui/TrajectoryLedger'

/**
 * wire DTO（epoch 毫秒）→ 组件模型（HH:MM:SS 展示字符串）的适配边界。
 * 契约类型不得直接进组件；所有时间格式化集中在本模块。
 */

/** epoch 毫秒 → HH:MM:SS。 */
export function formatEpochToClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function mapUsage(u: {
  readonly input: number
  readonly output: number
  readonly cache: number | null
}): TrajectoryTokenUsage {
  return { input: u.input, output: u.output, cache: u.cache ?? 0 }
}

function mapAttempt(q: TrajectoryAttemptDto): TrajectoryAttempt {
  return {
    id: q.id,
    seq: q.seq,
    model: q.model,
    attempt: q.attempt,
    durationMs: q.durationMs,
    status: q.status,
    at: formatEpochToClock(q.at),
    ...(q.tokens !== null && q.tokens !== undefined ? { tokens: mapUsage(q.tokens) } : {}),
    ...(q.error === undefined ? {} : { error: q.error }),
  }
}

function mapRecord(r: TrajectoryRecordDto): TrajectoryRecord {
  return {
    id: r.id,
    seq: r.seq,
    kind: r.kind,
    at: formatEpochToClock(r.at),
    summary: r.summary,
    ...(r.name === undefined ? {} : { name: r.name }),
    ...(r.target === undefined ? {} : { target: r.target }),
    ...(r.tokens === null || r.tokens === undefined ? {} : { tokens: mapUsage(r.tokens) }),
    ...(r.totalTokens === undefined ? {} : { totalTokens: r.totalTokens }),
    ...(r.durationMs === null || r.durationMs === undefined ? {} : { durationMs: r.durationMs }),
    ...(r.status === undefined ? {} : { status: r.status }),
    ...(r.children === undefined ? {} : { children: r.children.map(mapRecord) }),
    ...(r.attempts === undefined ? {} : { attempts: r.attempts.map(mapAttempt) }),
    ...(r.waitMs === undefined ? {} : { waitMs: r.waitMs }),
    ...(r.thinking === undefined ? {} : { thinking: r.thinking }),
    ...(r.reply === undefined ? {} : { reply: r.reply }),
    ...(r.params === undefined ? {} : { params: r.params }),
    ...(r.result === undefined ? {} : { result: r.result }),
    ...(r.model === undefined ? {} : { model: r.model }),
  }
}

function mapEndState(end: TrajectoryEndStateDto): TrajectoryTurnEnd {
  return {
    state: end.state,
    at: formatEpochToClock(end.at),
    ...(end.note === undefined ? {} : { note: end.note }),
  }
}

/** 会话轨迹的视图模型：轮次列表、压缩记录、结束标记与 token 合计。 */
export interface SessionTrajectoryView {
  readonly sessionId: string
  readonly title: string
  readonly turns: TrajectoryTurn[]
  readonly compaction?: TrajectoryCompaction | undefined
  readonly sessionEnd?: TrajectorySessionEnd | undefined
  /** 主会话累计 token；null = 未采集（G0）。 */
  readonly totalTokens: number | null
  readonly subAgentTokens: number
  readonly activeMs: number
  readonly spanMs: number
}

/** 会话轨迹响应 → 组件可直接消费的视图模型。 */
export function mapSessionTrajectory(dto: SessionTrajectoryDto): SessionTrajectoryView {
  return {
    sessionId: dto.sessionId,
    title: dto.title,
    turns: dto.turns.map((t): TrajectoryTurn => ({
      turn: t.turn,
      startedAt: formatEpochToClock(t.startedAt),
      durationMs: t.durationMs,
      tokens: t.tokens,
      records: t.records.map(mapRecord),
      ...(t.note === undefined ? {} : { note: t.note }),
      ...(t.endState === null || t.endState === undefined
        ? {}
        : { endState: mapEndState(t.endState) }),
    })),
    ...(dto.compaction === null || dto.compaction === undefined
      ? {}
      : {
          compaction: mapCompaction(dto.compaction),
        }),
    ...(dto.sessionEnd === null || dto.sessionEnd === undefined
      ? {}
      : {
          sessionEnd: {
            at: formatEpochToClock(dto.sessionEnd.at),
            state: dto.sessionEnd.state,
          },
        }),
    totalTokens: dto.totalTokens,
    subAgentTokens: dto.subAgentTokens,
    activeMs: dto.activeMs,
    spanMs: dto.spanMs,
  }
}

function mapCompaction(c: TrajectoryCompactionDto): TrajectoryCompaction {
  return {
    id: c.id,
    seq: c.seq,
    afterTurn: c.afterTurn,
    at: formatEpochToClock(c.at),
    durationMs: c.durationMs,
    beforeTokens: c.beforeTokens,
    afterTokens: c.afterTokens,
    messages: c.messages,
    status: c.status,
    ...(c.strategy === undefined ? {} : { strategy: c.strategy }),
  }
}
