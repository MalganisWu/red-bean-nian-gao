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

/**
 * epoch 毫秒 → HH:MM:SS。
 *
 * @param ms - epoch 毫秒时间戳。
 * @returns 本地时区的 `HH:MM:SS` 展示字符串。
 */
export function formatEpochToClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * token 用量适配：把 wire 侧的 nullable cache 归一成组件侧的数字。
 *
 * @param u - 后端用量对象；cache 为 null 表示未采集到缓存命中，需按 0 处理。
 * @returns 组件侧用量；缺失的 cache 一律落成 0，组件因此不必再判空。
 */
function mapUsage(u: {
  readonly input: number
  readonly output: number
  readonly cache: number | null
}): TrajectoryTokenUsage {
  return { input: u.input, output: u.output, cache: u.cache ?? 0 }
}

/**
 * 尝试明细适配：时间转成展示时钟，可选字段缺失时不产出对应键。
 *
 * @param q - 后端尝试 DTO；at 为 epoch 毫秒，tokens / error 均可缺省。
 * @returns 组件侧尝试对象；未采集到的 tokens、error 不出现在结果里。
 */
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

/**
 * 记录适配：递归转换子记录与尝试列表，时间字段统一转成展示时钟。
 *
 * @param r - 后端轨迹记录 DTO；children / attempts 会被递归映射。
 * @returns 组件侧记录；null 或 undefined 的可选字段一律不产出键。
 */
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

/**
 * 结束标记适配：结束状态原样透传，只把时间转成展示时钟。
 *
 * @param end - 后端结束标记 DTO；note 为可选的补充说明。
 * @returns 组件侧结束标记；note 缺失时不产出该键。
 */
function mapEndState(end: TrajectoryEndStateDto): TrajectoryTurnEnd {
  return {
    state: end.state,
    at: formatEpochToClock(end.at),
    ...(end.note === undefined ? {} : { note: end.note }),
  }
}

/** 会话轨迹的视图模型：轮次列表、压缩记录、结束标记与 token 合计。 */
export interface SessionTrajectoryView {
  /** 会话 id。 */
  readonly sessionId: string
  /** 会话标题；无标题时由映射层给出兜底文案。 */
  readonly title: string
  /** 逐轮次的轨迹（按时间序）。 */
  readonly turns: TrajectoryTurn[]
  /** 上下文压缩记录；无压缩时缺省。 */
  readonly compaction?: TrajectoryCompaction | undefined
  /** 会话结束标记；会话仍在进行或缺省时为空。 */
  readonly sessionEnd?: TrajectorySessionEnd | undefined
  /** 主会话累计 token；null = 未采集（G0）。 */
  readonly totalTokens: number | null
  /** 子 Agent 累计 token 合计。 */
  readonly subAgentTokens: number
  /** 会话内实际活跃时长（毫秒，已扣除轮次间空闲）。 */
  readonly activeMs: number
  /** 会话总跨度（毫秒，首尾时间戳之差）。 */
  readonly spanMs: number
}

/**
 * 会话轨迹响应 → 组件可直接消费的视图模型。
 *
 * @param dto - 后端会话轨迹响应；时间字段为 epoch 毫秒。
 * @returns 视图模型；所有时间已转成 `HH:MM:SS`，可选字段缺失时不产出对应键。
 */
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

/**
 * 压缩记录适配：前后的轮次边界与 token 数原样透传，时间转成展示时钟。
 *
 * @param c - 后端压缩记录 DTO；strategy 为可选压缩策略。
 * @returns 组件侧压缩记录；strategy 缺失时不产出该键。
 */
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
