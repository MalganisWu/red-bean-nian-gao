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

// 轨迹实时投影 store：与 chat-store 并行消费同一批 SSE 事件，做第二个投影
// （一条事件流、两个独立投影）。
//
// 口径纪律：
// - 进行中的记录只有开始标记，不虚构耗时（durationMs 缺省，时长列显示 —）；
// - live 耗时是客户端 Date.now 近似值；持久化数字以服务端为准；
// - DONE 的 tokens_used 是服务端真实值，直接作为轮次 token 合计。

/** 流式构建中的可变记录。 */
interface LiveRecord {
  /** 记录标识；实时侧用 `live-r<n>`，与历史回放序号错开避免两投影撞车。 */
  id: string
  /** 轮次内的显示序号（从 1 起）。 */
  seq: number
  /** 记录种类（调用 / 工具 / 子 Agent / 轮次结束等），决定渲染形态。 */
  kind: TrajectoryRecord['kind']
  /** 记录的展示时钟（HH:MM:SS），与持久化投影同格式。 */
  at: string
  /** 记录行摘要；随流式内容增长而更新，失败时带错误首行。 */
  summary: string
  /** 工具或子 Agent 的名称（用于按名对齐同一调用的多次事件）。 */
  name?: string
  /** 记录指向的目标名（如子 Agent 委派对象），缺省表示无。 */
  target?: string
  /** 已定稿的耗时（毫秒）；进行中的记录缺省，界面显示占位而非虚构耗时。 */
  durationMs?: number
  /** `interrupt` = LLM 发起挂起（等审批）；`incomplete` = 用户打断，均可能出现在实时侧。 */
  status?: 'success' | 'error' | 'running' | 'interrupt' | 'incomplete'
  /** 累积的思考文本；reason 事件逐段追加。 */
  thinking?: string
  /** 累积的回答文本；token 事件逐段追加，摘要优先取它。 */
  reply?: string
  /** 工具入参（已序列化为字符串）；无参数时缺省。 */
  params?: string
  /** 工具结果文本；成功时为返回内容，失败时缺省而由 error 承载。 */
  result?: string
  /** 本次 LLM 调用使用的模型名；未知时为空串。 */
  model?: string
  /** 本轮次 token 合计；DONE 事件带回服务端真实值时写入。 */
  totalTokens?: number
  /** 内嵌的子记录（如子 Agent 展开的工具行）。 */
  children?: TrajectoryRecord[]
  /** 本次调用的尝试明细（status 事件驱动）。 */
  attempts?: TrajectoryAttempt[]
  /** 审批等待时长（工具行）；实时侧由落定的挂起时刻推算。 */
  waitMs?: number
}

/** 实时投影中的一轮：轮次号 + 起始时刻 + 已构建的记录，与持久化轮次靠 turnBase 对齐。 */
interface LiveTurn {
  /**
   * 轮次号。与持久化历史投影对齐（见 alignToHistory），使同一个 run 在两个投影里
   * 拿到同一个轮次号——视图据此用实时轮次取代历史里那条尚未终结的轮次。
   */
  turn: number
  /** 轮次起始的展示时钟（HH:MM:SS）。 */
  startedAt: string
  /** 轮次起始的 epoch 毫秒；用于计算耗时与对齐。 */
  startedAtMs: number
  /** 本轮已构建的记录列表（按发生顺序）。 */
  records: LiveRecord[]
  /** 当前未定的步骤记录（reason/token 累积点）。 */
  currentCall?: LiveRecord | undefined
}

/** 实时投影与历史投影的对齐基准：已终结的历史轮次数。 */
export interface TrajectoryHistoryBase {
  /** 已终结的历史轮次数；实时轮次号从它之后续接。 */
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
  /**
   * 并入一条 SSE 事件；类型未知或缺少归属轮次时原样返回、不产生更新。
   *
   * @param event - 单条已解析的 SSE 事件；按 eventType 分派到对应分支。
   */
  readonly applyEvent: (event: ParsedSSEEvent) => void
  /**
   * 新一轮用户输入开始时调用（发送即开轮，不等 START）。
   *
   * @param content - 用户输入原文；直接作为本轮第一条 user 记录的摘要。
   * @param sessionId - 会话 id；新会话此时可能还没拿到（START 事件才带回），允许 null/undefined。
   */
  readonly beginUserTurn: (content: string, sessionId?: string | null) => void
  /**
   * 用已加载的历史轨迹对齐轮次号：设定基准，并把流式途中已建立的实时轮次按基准重编号
   * （视图在流式进行中打开时会先有临时轮次号，随后才拿到历史）。
   *
   * @param base - 对齐基准；取其 turnBase 作为实时轮次的起始序号。
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
  /** 清空实时投影（会话 id、轮次与计时表）。 */
  readonly reset: () => void
}

/** 实时记录 id 的全局递增号源；与历史回放序号错开命名，避免两个投影的 id 撞车。 */
let SEQ = 0
/**
 * 实时尝试项（attempt）id 的全局递增号源。
 * 与 SEQ 分开计数：一次调用可能有多次尝试，共用一个号源会让记录与尝试的编号互相跳动。
 */
let REQ_SEQ = 0
/** 生成实时记录的全局唯一 id（`live-r<n>`）；同一次会话内不复用，便于按 id 对齐两个投影。 */
const nextId = () => `live-r${++SEQ}`
/** 生成实时尝试项的全局唯一 id（`live-q<n>`）；前缀与记录 id 区分，调试时一眼可辨来源。 */
const nextReqId = () => `live-q${++REQ_SEQ}`

/**
 * epoch 毫秒 → HH:MM:SS 展示时钟。
 * 实时侧统一走这一处：与持久化投影同格式，流式与回放切换时时间列不会变形。
 *
 * @param ms - epoch 毫秒时间戳。
 */
const clock = (ms: number) => formatEpochToClock(ms)

/** 审批行的展示名：与持久化投影的 cardRecord 口径一致（两侧同源，便于按 callId 对齐）。 */
const APPROVAL_ROW_NAME = 'approval'

/**
 * 当前轮次的可写引用；没有则忽略事件（防御乱序）。
 *
 * @param turns - 实时轮次列表；始终取末尾一轮作为事件的归属轮次。
 * @returns 末尾轮次；列表为空时返回 undefined，调用方据此直接丢弃该事件。
 */
function currentTurn(turns: readonly LiveTurn[]): LiveTurn | undefined {
  return turns.at(-1)
}

/**
 * 发送即开轮：建立本轮实时轮次，轮次号续在已终结的历史轮次之后。
 *
 * @param state - 当前实时投影状态；只读，用于取 turnBase 推算本轮轮次号。
 * @param content - 用户输入原文；直接作为本轮第一条 user 记录的摘要。
 * @param sessionId - 会话 id；新会话此时可能还没拿到（START 事件才带回），允许 null/undefined。
 * @returns 仅含 liveTurns / recordStartTimes / liveSessionId 的状态补丁，交由 set 合并。
 */
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
  // 只保留"当前进行中的一轮"：已结束的轮次以持久化历史为准，实时侧不留存——
  // 否则视图重新打开时同一个 run 会既出现在历史里、又出现在实时投影里（重复轮次）。
  return {
    liveTurns: [turn],
    recordStartTimes: {},
    // 新会话此时还没有 session_id（START 才带回），先记已知值，START 会补齐
    liveSessionId: sessionId ?? null,
  }
}

/**
 * 把一条 SSE 事件并入实时轨迹投影；未知类型与乱序事件原样返回，不产生更新。
 *
 * @param state - 当前实时投影状态；只读，内部先复制轮次再改动。
 * @param event - 单条已解析的 SSE 事件；按 eventType 分派到对应分支。
 * @returns 状态补丁；类型未知或前置条件不满足（如缺少归属轮次）时返回原 state，表示不更新。
 */
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
      // 摘要必须跟随回答一起增长，且与持久化投影同口径（有回答取回答首行）。
      // 只更新 reply 会让记录行在整个作答期间一动不动——看起来像轨迹停住了。
      step.summary = callSummary(step)
      return { liveTurns: turns }
    }
    case SSE_EVENT_TYPES.STATUS: {
      if (!turn || !isStatusEvent(event.data)) return state
      const code = event.data.code
      if (code === 'llm_retry' || code === 'llm_empty_response_retry') {
        const step = ensureCall(turn)
        // 上一次尝试以失败告终，新一次尝试开始
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
          // 失败摘要与持久化投影同口径（带错误首行），否则流式与回放两态对不上
          summary: failed
            ? `${data.tool_name} 失败：${firstLine(data.error ?? '')}`
            : firstLine(data.content || data.tool_name),
        }
        // 计时起点在 recordStartTimes 侧表（记录本体不带流式计时字段）
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
      // 流式错误：本轮以失败终态收尾（轨迹如实记录失败，不做成功伪装）
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
      // 审批挂起：LLM 决定调用 interrupting 工具，服务端在流结束前发 card 事件。
      // 轨迹侧据此合成一行「工具 · 等待审批」——否则这次调用在实时视图里完全不存在
      // （interrupting 工具不发 tool_start / tool_result），与持久化视图对不上。
      // `interaction_id` 就是 callId，与持久化侧按 callId 重建出的行同源。
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
    // heartbeat（心跳）由 chat 主投影承担，轨迹投影不消费
    case SSE_EVENT_TYPES.HEARTBEAT:
      return state
    default:
      return state
  }
}

/**
 * 轨迹专用 store；与 chat 主投影消费同一批 SSE 事件，但各自维护独立投影。
 */
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

/**
 * 全局递增序号（与历史回放同序衔接）。
 *
 * @param turns - 实时轮次列表；累加各轮已有记录数即得下一个序号。
 * @returns 下一个可用的全局序号（从 1 起，跨轮连续）。
 */
function nextSeqValue(turns: readonly LiveTurn[]): number {
  return turns.reduce((n, t) => n + t.records.length, 0) + 1
}

/**
 * 取当前 LLM 调用记录；没有则新建（流式中 reason/token 的归属点）。
 * 不再分配轮次内调用序号——行序本身表达顺序，`#N` 全局序号承担引用职责。
 *
 * @param turn - 事件归属的实时轮次；其 currentCall 字段即下一段思考/回答的落脚点。
 * @returns 当前调用记录；已存在则直接复用，否则新建并挂到该轮末尾。
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

/**
 * 把一次尝试（attempt）落定为终态：改写 status，并在带错误时补上 error 文本。
 *
 * @param req - 待落定的尝试记录；只读取，不就地修改。
 * @param status - 落定终态，仅 success / error 两种。
 * @param error - 失败原因文本；缺省表示无错误，此时不产出 error 键。
 * @returns 落定后的新尝试对象；原对象保持不变。
 */
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

/**
 * 取文本首行作为摘要，并在超长时截断兜底。
 *
 * @param text - 原始文本；可能多行、可能为空。
 * @returns 首行；空文本返回空串，超过 200 字符时截断并追加省略号。
 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  // 200 字符与截断标记必须与后端持久化投影（SUMMARY_MAX_CHARS）保持一致：
  // 流式与回放切换时摘要不应无端变样。视觉截断由 CSS 负责，这里只是防御上限。
  return line.length > 200 ? `${line.slice(0, 200)}...` : line
}

/**
 * 步骤摘要：与后端持久化投影同口径——有回答内容时取回答首行，否则回落到思考首行。
 * 流式期间两者都在增长，因此记录行文本会持续跟随，而不是停在思考的第一句。
 *
 * @param step - 当前 LLM 调用记录；按 reply 优先、thinking 兜底的顺序取文本。
 * @returns 摘要首行；两者都为空时返回「进行中…」占位。
 */
function callSummary(step: LiveRecord): string {
  const text = step.reply !== undefined && step.reply !== '' ? step.reply : step.thinking
  if (text === undefined || text === '') return '进行中…'
  return firstLine(text)
}

export type { LiveRecord, LiveTurn }

// store 一律不做热替换：React Fast Refresh 只重建"接受更新"的组件边界，没被重建的模块
// （如 useChatStream）会继续持有旧 store 实例，于是写入方与读取方各绑一份 state——
// 表现就是实时投影不再跟随 SSE、流结束后同一轮出现两次。这里声明自接受并整页刷新，
// 代价是开发期一次刷新，换来实例唯一（import.meta.hot 在生产构建中为 undefined）。
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
