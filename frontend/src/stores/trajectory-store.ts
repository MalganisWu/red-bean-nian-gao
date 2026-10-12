import { create } from 'zustand'

import {
  isCardEvent,
  isCompactionEvent,
  isDoneEvent,
  isReasonEvent,
  isStartEvent,
  isStatusEvent,
  isSubAgentEnvelope,
  isTokenEvent,
  isToolResultEvent,
  isToolStartEvent,
  SSE_EVENT_TYPES,
  type ParsedSSEEvent,
} from '@/types/events'
import type { TrajectoryAttempt, TrajectoryRecord } from '@/components/retroui/TrajectoryLedger'
import { formatEpochToClock } from '@/pages/chat/trajectory-mapper'

/**
 * 轨迹实时投影 store：与 chat-store 并行消费同一批 SSE 事件，做第二个投影
 * （一条事件流、两个独立投影）。
 *
 * 口径纪律：
 * - 进行中的记录只有开始标记，不虚构耗时（durationMs 缺省，时长列显示 —）；
 * - live 耗时是客户端 Date.now 近似值；持久化数字以服务端为准；
 * - DONE 的 tokens_used 是服务端真实值，直接作为轮次 token 合计。
 */

/** 流式构建中的可变记录。 */
interface LiveRecord {
  id: string
  seq: number
  kind: TrajectoryRecord['kind']
  at: string
  summary: string
  name?: string
  target?: string
  durationMs?: number
  /** `interrupt` = LLM 发起挂起（等审批）；`incomplete` = 用户打断，均可能出现在实时侧。 */
  status?: 'success' | 'error' | 'running' | 'interrupt' | 'incomplete'
  thinking?: string
  reply?: string
  params?: string
  result?: string
  model?: string
  totalTokens?: number
  children?: TrajectoryRecord[]
  /** 本次调用的尝试明细（status 事件驱动）。 */
  attempts?: TrajectoryAttempt[]
  /** 审批等待时长（工具行）；实时侧由落定的挂起时刻推算。 */
  waitMs?: number
}

interface LiveTurn {
  /**
   * 轮次号。与持久化历史投影对齐（见 alignToHistory），使同一个 run 在两个投影里
   * 拿到同一个轮次号——视图据此用实时轮次取代历史里那条尚未终结的轮次。
   */
  turn: number
  startedAt: string
  startedAtMs: number
  records: LiveRecord[]
  /** 当前未定的步骤记录（reason/token 累积点）。 */
  currentCall?: LiveRecord | undefined
}

/** 实时投影与历史投影的对齐基准：已终结的历史轮次数。 */
export interface TrajectoryHistoryBase {
  readonly turnBase: number
}

/** 轨迹实时投影的状态与动作；轮次号以 `turnBase` 为基准，与持久化历史对齐。 */
export interface TrajectoryLiveState {
  /** 正在进行流式的会话 id；null = 无实时投影。 */
  readonly streamingSessionId: string | null
  /**
   * 当前实时轮次所属会话 id（START 受理后确定）。
   * 与 streamingSessionId 分离：流结束后本字段仍然保留，视图据此继续渲染实时轮次，
   * 直到流结束触发的持久化重拉落地（否则会出现"实时已撤、历史未到"的空窗）。
   */
  readonly liveSessionId: string | null
  /** 正在构建的轮次（仅会话内有效，不进持久化）。 */
  readonly liveTurns: readonly LiveTurn[]
  /** 已终结的历史轮次数；实时轮次号从它之后续接。 */
  readonly turnBase: number
  /** 进行中记录的客户端计时起点（recordId → startMs）；定稿时换算 durationMs 后清除。 */
  readonly recordStartTimes: Readonly<Record<string, number>>
  readonly applyEvent: (event: ParsedSSEEvent) => void
  /** 新一轮用户输入开始时调用（发送即开轮，不等 START）。 */
  readonly beginUserTurn: (content: string, sessionId?: string | null) => void
  /**
   * 用已加载的历史轨迹对齐轮次号：设定基准，并把流式途中已建立的实时轮次按基准重编号
   * （视图在流式进行中打开时会先有临时轮次号，随后才拿到历史）。
   */
  readonly alignToHistory: (base: TrajectoryHistoryBase) => void
  /** 丢弃实时轮次（持久化轮次已经接管展示时调用）。 */
  readonly clearLiveTurns: () => void
  /**
   * 流结束时把仍处于 `running` 的记录收尾成 `incomplete`。
   *
   * 与 chat 投影的 `settleIncompleteTools` 同构：SSE 上不存在「用户刚打断了自己」的服务端事件
   * （取消由客户端 abort 连接发起），不主动收尾就会让终态页面永久显示「正在执行」。
   * 五条流结束路径（DONE / ERROR / 网络错误 / onClose / cancel）都必须调用——
   * 与 chat 投影的 `settleIncompleteTools` 保持同址。
   */
  readonly settleIncomplete: () => void
  readonly reset: () => void
}

let SEQ = 0
let REQ_SEQ = 0
const nextId = () => `live-r${++SEQ}`
const nextReqId = () => `live-q${++REQ_SEQ}`

const clock = (ms: number) => formatEpochToClock(ms)

/** 审批行的展示名：与持久化投影的 cardRecord 口径一致（两侧同源，便于按 callId 对齐）。 */
const APPROVAL_ROW_NAME = 'approval'

/** 当前轮次的可写引用；没有则忽略事件（防御乱序）。 */
function currentTurn(turns: readonly LiveTurn[]): LiveTurn | undefined {
  return turns.at(-1)
}

/** 发送即开轮：建立本轮实时轮次，轮次号续在已终结的历史轮次之后。 */
function beginTurnState(
  state: TrajectoryLiveState,
  content: string,
  sessionId: string | null | undefined
): Partial<TrajectoryLiveState> {
  const now = Date.now()
  const turn: LiveTurn = {
    turn: state.turnBase + 1,
    startedAt: clock(now),
    startedAtMs: now,
    records: [
      {
        id: nextId(),
        seq: 1,
        kind: 'user',
        at: clock(now),
        summary: content,
      },
    ],
  }
  /* 只保留"当前进行中的一轮"：已结束的轮次以持久化历史为准，实时侧不留存——
     否则视图重新打开时同一个 run 会既出现在历史里、又出现在实时投影里（重复轮次）。 */
  return {
    liveTurns: [turn],
    recordStartTimes: {},
    /* 新会话此时还没有 session_id（START 才带回），先记已知值，START 会补齐 */
    liveSessionId: sessionId ?? null,
  }
}

/** 把一条 SSE 事件并入实时轨迹投影；未知类型与乱序事件原样返回，不产生更新。 */
function reduceTrajectoryEvent(
  state: TrajectoryLiveState,
  event: ParsedSSEEvent
): Partial<TrajectoryLiveState> {
  const turns = state.liveTurns.map((t) => ({ ...t, records: [...t.records] }))
  const turn = currentTurn(turns)
  switch (event.eventType) {
    case SSE_EVENT_TYPES.START: {
      if (!isStartEvent(event.data)) return state
      return {
        streamingSessionId: event.data.session_id,
        liveSessionId: event.data.session_id,
        liveTurns: turns,
      }
    }
    case SSE_EVENT_TYPES.REASON: {
      if (!turn || !isReasonEvent(event.data)) return state
      const step = ensureCall(turn)
      step.thinking = (step.thinking ?? '') + event.data.content
      step.summary = callSummary(step)
      return { liveTurns: turns }
    }
    case SSE_EVENT_TYPES.TOKEN: {
      if (!turn || !isTokenEvent(event.data)) return state
      const step = ensureCall(turn)
      step.reply = (step.reply ?? '') + event.data.content
      /* 摘要必须跟随回答一起增长，且与持久化投影同口径（有回答取回答首行）。
         只更新 reply 会让记录行在整个作答期间一动不动——看起来像轨迹停住了。 */
      step.summary = callSummary(step)
      return { liveTurns: turns }
    }
    case SSE_EVENT_TYPES.STATUS: {
      if (!turn || !isStatusEvent(event.data)) return state
      const code = event.data.code
      if (code === 'llm_retry' || code === 'llm_empty_response_retry') {
        const step = ensureCall(turn)
        /* 上一次尝试以失败告终，新一次尝试开始 */
        const attempts: TrajectoryAttempt[] = [...(step.attempts ?? [])]
        const prev = attempts.at(-1)
        if (prev?.status === 'running') {
          attempts[attempts.length - 1] = settleAttempt(prev, 'error', event.data.content)
        }
        attempts.push({
          id: nextReqId(),
          seq: (prev?.seq ?? 0) + 1,
          model: '',
          attempt: `${event.data.attempt ?? attempts.length + 1}/${event.data.max_attempts ?? '?'}`,
          durationMs: 0,
          status: 'running',
          at: clock(Date.now()),
        })
        step.attempts = attempts
      }
      return { liveTurns: turns }
    }
    case SSE_EVENT_TYPES.TOOL_START: {
      if (!turn || !isToolStartEvent(event.data)) return state
      turn.currentCall = undefined
      const recordId = nextId()
      turn.records.push({
        id: recordId,
        seq: nextSeqValue(turns),
        kind: 'tool',
        at: clock(Date.now()),
        summary: event.data.tool_name,
        name: event.data.tool_name,
        status: 'running',
        ...(event.data.params !== null && event.data.params !== undefined
          ? { params: JSON.stringify(event.data.params) }
          : {}),
      })
      return {
        liveTurns: turns,
        recordStartTimes: { ...state.recordStartTimes, [recordId]: Date.now() },
      }
    }
    case SSE_EVENT_TYPES.TOOL_RESULT: {
      if (!turn || !isToolResultEvent(event.data)) return state
      const data = event.data
      const idx = turn.records.findIndex(
        (r) => r.kind === 'tool' && r.status === 'running' && r.name === data.tool_name
      )
      const target = idx >= 0 ? turn.records[idx] : undefined
      if (target !== undefined) {
        const failed = data.error !== undefined && data.error !== ''
        const settled: LiveRecord = {
          ...target,
          status: failed ? 'error' : 'success',
          result: failed ? data.error : data.content,
          /* 失败摘要与持久化投影同口径（带错误首行），否则流式与回放两态对不上 */
          summary: failed
            ? `${data.tool_name} 失败：${firstLine(data.error ?? '')}`
            : firstLine(data.content || data.tool_name),
        }
        /* 计时起点在 recordStartTimes 侧表（记录本体不带流式计时字段） */
        const startedAt = state.recordStartTimes[target.id]
        if (startedAt !== undefined) {
          settled.durationMs = Math.max(0, Date.now() - startedAt)
        }
        turn.records[idx] = settled
        const nextTimes = { ...state.recordStartTimes }
        delete nextTimes[target.id]
        return { liveTurns: turns, recordStartTimes: nextTimes }
      }
      return { liveTurns: turns }
    }
    case SSE_EVENT_TYPES.COMPACTION: {
      if (!turn || !isCompactionEvent(event.data)) return state
      turn.records.push({
        id: nextId(),
        seq: nextSeqValue(turns),
        kind: 'tool',
        at: clock(Date.now()),
        summary: `上下文压缩：${event.data.pre_tokens.toLocaleString('en-US')} → ${event.data.post_tokens.toLocaleString('en-US')} tok`,
        name: 'compaction',
        status: 'success',
      })
      return { liveTurns: turns }
    }
    case SSE_EVENT_TYPES.AGENT_EVENT: {
      if (!turn || !isSubAgentEnvelope(event.data)) return state
      const data = event.data
      const existing = turn.records.find((r) => r.kind === 'subagent' && r.name === data.agent_name)
      if (existing === undefined) {
        const recordId = nextId()
        turn.records.push({
          id: recordId,
          seq: nextSeqValue(turns),
          kind: 'subagent',
          at: clock(Date.now()),
          summary: data.agent_name,
          name: data.agent_name,
          status: 'running',
        })
        return {
          liveTurns: turns,
          recordStartTimes: { ...state.recordStartTimes, [recordId]: Date.now() },
        }
      }
      return { liveTurns: turns }
    }
    case SSE_EVENT_TYPES.DONE: {
      if (!turn || !isDoneEvent(event.data)) return state
      turn.records.push({
        id: nextId(),
        seq: nextSeqValue(turns),
        kind: 'turn-end',
        at: clock(Date.now()),
        summary: `轮次 ${turn.turn} 结束 · 完成`,
      })
      return { streamingSessionId: null, liveTurns: turns }
    }
    case SSE_EVENT_TYPES.ERROR: {
      /* 流式错误：本轮以失败终态收尾（轨迹如实记录失败，不做成功伪装） */
      if (!turn) return state
      turn.records.push({
        id: nextId(),
        seq: nextSeqValue(turns),
        kind: 'turn-end',
        at: clock(Date.now()),
        summary: `轮次 ${turn.turn} 结束 · 失败`,
      })
      return { streamingSessionId: null, liveTurns: turns }
    }
    case SSE_EVENT_TYPES.CARD: {
      /* 审批挂起：LLM 决定调用 interrupting 工具，服务端在流结束前发 card 事件。
             轨迹侧据此合成一行「工具 · 等待审批」——否则这次调用在实时视图里完全不存在
             （interrupting 工具不发 tool_start / tool_result），与持久化视图对不上。
             `interaction_id` 就是 callId，与持久化侧按 callId 重建出的行同源。 */
      if (!turn || !isCardEvent(event.data)) return state
      const card = event.data
      if (card.status !== 'pending') return state
      const existing = turn.records.find(
        (r) => r.kind === 'tool' && r.name === APPROVAL_ROW_NAME && r.id === card.interaction_id
      )
      if (existing !== undefined) return state
      const firstQuestion = card.questions.at(0)
      turn.records.push({
        id: card.interaction_id,
        seq: nextSeqValue(turns),
        kind: 'tool',
        at: clock(Date.now()),
        summary: firstQuestion?.text ?? '等待用户确认',
        name: APPROVAL_ROW_NAME,
        status: 'interrupt',
      })
      return { liveTurns: turns }
    }
    /* heartbeat（心跳）由 chat 主投影承担，轨迹投影不消费 */
    case SSE_EVENT_TYPES.HEARTBEAT:
      return state
    default:
      return state
  }
}

/** 轨迹专用 store；与 chat 主投影消费同一批 SSE 事件，但各自维护独立投影。 */
export const useTrajectoryStore = create<TrajectoryLiveState>()((set) => ({
  streamingSessionId: null,
  liveSessionId: null,
  liveTurns: [],
  turnBase: 0,
  recordStartTimes: {},

  beginUserTurn: (content, sessionId) => set((state) => beginTurnState(state, content, sessionId)),

  alignToHistory: (base) =>
    set((state) => ({
      turnBase: base.turnBase,
      liveTurns: state.liveTurns.map((turn, index) => ({
        ...turn,
        turn: base.turnBase + index + 1,
      })),
    })),

  clearLiveTurns: () => set({ liveTurns: [], recordStartTimes: {}, liveSessionId: null }),

  applyEvent: (event) => set((state) => reduceTrajectoryEvent(state, event)),

  settleIncomplete: () =>
    set((state) => ({
      liveTurns: state.liveTurns.map((turn) => ({
        ...turn,
        records: turn.records.map((record) =>
          record.status === 'running' ? { ...record, status: 'incomplete' } : record
        ),
      })),
      recordStartTimes: {},
    })),

  reset: () =>
    set({
      streamingSessionId: null,
      liveSessionId: null,
      liveTurns: [],
      recordStartTimes: {},
      turnBase: 0,
    }),
}))

/** 全局递增序号（与历史回放同序衔接）。 */
function nextSeqValue(turns: readonly LiveTurn[]): number {
  return turns.reduce((n, t) => n + t.records.length, 0) + 1
}

/**
 * 取当前 LLM 调用记录；没有则新建（流式中 reason/token 的归属点）。
 * 不再分配轮次内调用序号——行序本身表达顺序，`#N` 全局序号承担引用职责。
 */
function ensureCall(turn: LiveTurn): LiveRecord {
  if (turn.currentCall !== undefined) return turn.currentCall
  const call: LiveRecord = {
    id: nextId(),
    seq: turn.records.length + 1,
    kind: 'call',
    at: clock(Date.now()),
    summary: '进行中…',
    status: 'running',
  }
  turn.records.push(call)
  turn.currentCall = call
  return call
}

function settleAttempt(
  req: TrajectoryAttempt,
  status: 'success' | 'error',
  error?: string
): TrajectoryAttempt {
  return {
    ...req,
    status,
    ...(error === undefined ? {} : { error }),
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  /* 200 字符与截断标记必须与后端持久化投影（SUMMARY_MAX_CHARS）保持一致：
     流式与回放切换时摘要不应无端变样。视觉截断由 CSS 负责，这里只是防御上限。 */
  return line.length > 200 ? `${line.slice(0, 200)}...` : line
}

/**
 * 步骤摘要：与后端持久化投影同口径——有回答内容时取回答首行，否则回落到思考首行。
 * 流式期间两者都在增长，因此记录行文本会持续跟随，而不是停在思考的第一句。
 */
function callSummary(step: LiveRecord): string {
  const text = step.reply !== undefined && step.reply !== '' ? step.reply : step.thinking
  if (text === undefined || text === '') return '进行中…'
  return firstLine(text)
}

export type { LiveRecord, LiveTurn }

/* store 一律不做热替换：React Fast Refresh 只重建"接受更新"的组件边界，没被重建的模块
   （如 useChatStream）会继续持有旧 store 实例，于是写入方与读取方各绑一份 state——
   表现就是实时投影不再跟随 SSE、流结束后同一轮出现两次。这里声明自接受并整页刷新，
   代价是开发期一次刷新，换来实例唯一（import.meta.hot 在生产构建中为 undefined）。 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
