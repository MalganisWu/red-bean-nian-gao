import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import { BackLink } from '@/components/layout/BackLink'
import { TrajectoryInspector } from '@/components/retroui/TrajectoryInspector'
import { TrajectoryLedger } from '@/components/retroui/TrajectoryLedger'
import { TrajectoryTimeline } from '@/components/retroui/TrajectoryTimeline'
import type {
  TrajectoryCompaction,
  TrajectoryRecord,
  TrajectoryAttempt,
  TrajectoryTurn,
} from '@/components/retroui/TrajectoryLedger'
import { useFollowTail } from '@/hooks/useFollowTail'
import { fetchSessionTrajectory, type SessionTrajectoryDto } from '@/services/api/trajectory'
import { useChatStore } from '@/stores/chat-store'
import { useTrajectoryStore, type LiveTurn } from '@/stores/trajectory-store'

import { mapSessionTrajectory, type SessionTrajectoryView } from './trajectory-mapper'

interface SessionTrajectoryViewProps {
  onBack: () => void
}

/**
 * 在**展示轮次**里按 id 查找记录 / 请求 / 所属轮次（检查器选中解析）。
 *
 * 必须在 `displayTurns`（历史 + 实时）上查找，而不是只在持久化的 `view.turns` 上：
 * 流式进行中，实时轮次只存在于 store 的 `liveTurns` 里、**不在 `view` 里**，
 * 用 `view` 查找会让点击任何一行都解析不到 → `inspectorOpen` 恒为 false → 界面毫无反应。
 */
function findRecord(
  turns: readonly TrajectoryTurn[],
  id: string | undefined
): TrajectoryRecord | undefined {
  if (!id) return undefined
  for (const turn of turns) {
    for (const record of turn.records) {
      if (record.id === id) return record
      for (const child of record.children ?? []) if (child.id === id) return child
    }
  }
  return undefined
}

function findRequest(
  turns: readonly TrajectoryTurn[],
  id: string | undefined
): TrajectoryAttempt | undefined {
  if (!id) return undefined
  for (const turn of turns) {
    for (const record of turn.records) {
      for (const req of record.attempts ?? []) if (req.id === id) return req
    }
  }
  return undefined
}

function turnLabelOf(turns: readonly TrajectoryTurn[], id: string | undefined): string | undefined {
  if (!id) return undefined
  for (const turn of turns) {
    const hit = turn.records.some(
      (r) =>
        r.id === id ||
        (r.children ?? []).some((c) => c.id === id) ||
        (r.attempts ?? []).some((q) => q.id === id)
    )
    if (hit) return `轮次 ${turn.turn}`
  }
  return undefined
}

function findCompaction(view: SessionTrajectoryView | null): TrajectoryCompaction | undefined {
  return view?.compaction
}

/**
 * 实时投影轮次 → 组件轮次模型（剥掉客户端计时的 startedAtMs）。
 * 轮次号与记录序号都续接已终结的历史投影：两个投影消费同一条事件流，序号必须连续，
 * 否则记录表里会出现重复的轮次号与重复的 #序号。
 */
function liveTurnToTurn(
  t: LiveTurn,
  nowMs: number,
  turnNo: number,
  seqStart: number
): SessionTrajectoryView['turns'][number] {
  let seq = seqStart
  const records: TrajectoryRecord[] = []
  for (const record of t.records) {
    seq += 1
    const next: TrajectoryRecord = { ...record, seq }
    if (record.attempts !== undefined) {
      /* 尝试明细展开在所属调用下方，序号按同一展示顺序续接 */
      const attempts: TrajectoryAttempt[] = []
      for (const attempt of record.attempts) {
        seq += 1
        attempts.push({ ...attempt, seq })
      }
      next.attempts = attempts
    }
    records.push(next)
  }
  return {
    turn: turnNo,
    startedAt: t.startedAt,
    /* nowTick 未跳秒前（isLive 刚置真）耗时按 0 显示，不做虚构 */
    durationMs: nowMs > 0 ? Math.max(0, nowMs - t.startedAtMs) : 0,
    tokens: null,
    records,
  }
}

/**
 * 实时投影只续接在"已终结轮次"之后：历史里最后一轮若尚未终结，它就是正在流式的同一个 run
 * （run 容器在运行开始即落库），必须由实时轮次取代，而不是在记录表里并排出现两次。
 */
function settledTurnsOf(turns: readonly TrajectoryTurn[]): TrajectoryTurn[] {
  return turns.filter((turn, index) => index !== turns.length - 1 || turn.endState !== undefined)
}

/** 单条记录与其请求子记录中的最大序号。 */
function maxSeqOfRecord(record: TrajectoryRecord): number {
  let max = record.seq ?? 0
  for (const request of record.attempts ?? []) {
    max = Math.max(max, request.seq ?? 0)
  }
  return max
}

/** 单个轮次内全部记录（含展开的请求子记录）的最大序号。 */
function maxSeqOfTurn(turn: TrajectoryTurn): number {
  let max = 0
  for (const record of turn.records) {
    max = Math.max(max, maxSeqOfRecord(record))
  }
  return max
}

/** 轮次集合里的最大记录序号（含展开的请求子记录）。 */
function maxRecordSeq(turns: readonly TrajectoryTurn[]): number {
  let max = 0
  for (const turn of turns) {
    max = Math.max(max, maxSeqOfTurn(turn))
  }
  return max
}

/** 轮次在展示上的记录条数（含请求子记录），用于给后续实时轮次推移序号。 */
function liveRecordCount(turn: LiveTurn): number {
  return turn.records.reduce((n, record) => n + 1 + (record.attempts?.length ?? 0), 0)
}

/**
 * 展示轮次 = 已终结的历史轮次 + 实时轮次的续接投影。
 * 有实时轮次时（流式进行中，或流刚结束但持久化重拉尚未落地）才叠加，否则直接用历史。
 */
function buildDisplayTurns(
  view: SessionTrajectoryView | null,
  hasLiveTurn: boolean,
  liveTurns: readonly LiveTurn[],
  nowTick: number
): TrajectoryTurn[] {
  const historical = view?.turns ?? []
  if (!hasLiveTurn) return historical
  const settled = settledTurnsOf(historical)
  const seqBase = maxRecordSeq(settled)
  let consumed = 0
  const live: TrajectoryTurn[] = []
  for (const [index, turn] of liveTurns.entries()) {
    const mapped = liveTurnToTurn(turn, nowTick, settled.length + index + 1, seqBase + consumed)
    consumed += liveRecordCount(turn)
    live.push(mapped)
  }
  return [...settled, ...live]
}

/**
 * 应用拉取到的持久化轨迹：更新视图，并按轮次位置决定是否丢弃实时轮次、对齐轮次号。
 * 实时轮次交接判定见 `load` 上方的注释。
 */
function applyLoadedTrajectory(
  dto: SessionTrajectoryDto,
  sessionId: string,
  setView: Dispatch<SetStateAction<SessionTrajectoryView | null>>,
  setLoadedFor: Dispatch<SetStateAction<string | null>>
): void {
  const mapped = mapSessionTrajectory(dto)
  const store = useTrajectoryStore.getState()
  const liveTurnNo = store.liveTurns.at(-1)?.turn
  const settledCount = settledTurnsOf(mapped.turns).length
  setView(mapped)
  setLoadedFor(sessionId)
  if (liveTurnNo !== undefined && settledCount >= liveTurnNo) {
    store.clearLiveTurns()
    return
  }
  // 对齐轮次号：实时投影续接已终结的历史轮次，同一个 run 在两侧拿到同一个编号
  store.alignToHistory({ turnBase: settledCount })
}

/**
 * 会话轨迹子视图（ChatPage SessionView='trajectory'）：只读审计页。
 * 组合三个入册组件：泳道时序概览 + 轮次记录表 + 记录检查器；
 * 历史读持久化数据，流式进行中叠加 trajectory-store 的实时投影（第二投影）。
 */
export function SessionTrajectoryView({ onBack }: SessionTrajectoryViewProps) {
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const [view, setView] = useState<SessionTrajectoryView | null>(null)
  /* 以「已为哪个会话加载成功」推导加载态，避免在 effect 体内同步 setState */
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  /** 点产出行时携带的 tab（思考 / 正文 / 工具调用），让详情直接停在那一块。 */
  const [selectedTab, setSelectedTab] = useState<string | undefined>(undefined)
  const [focusIds, setFocusIds] = useState<ReadonlySet<string> | null>(null)

  /* 实时投影：本会话流式进行中时，把 liveTurns 叠加到历史视图之后 */
  const liveTurns = useTrajectoryStore((s) => s.liveTurns)
  const streamingSessionId = useTrajectoryStore((s) => s.streamingSessionId)
  const liveSessionId = useTrajectoryStore((s) => s.liveSessionId)
  /* 「正在流式」只驱动跟随尾部、跳秒与隐藏会话终态；「有实时轮次可展示」独立成立：
     流结束后实时轮次必须继续渲染，直到流结束触发的持久化重拉落地，否则会出现
     "实时已撤、历史未到"的空窗（看起来就是轨迹突然清空或直接跳到上一场的终态）。 */
  const streaming = streamingSessionId !== null && streamingSessionId === activeSessionId
  const hasLiveTurn = liveTurns.length > 0 && liveSessionId === activeSessionId

  const loading = activeSessionId !== null && loadedFor !== activeSessionId && error === null

  /**
   * 读取持久化轨迹。
   *
   * 实时轮次与持久化轮次的交接规则：**只要这次拿到的历史里，实时轮次所在的位置已经是一条
   * 已终结的轮次，就说明那个 run 已经落库，实时轮次必须当场丢弃**——不能依赖"流结束"这个
   * 时间点触发，否则流被中止、DONE 丢失或实例不一致时，实时轮次会一直挂着，与历史上同一个
   * run 并列成两条同号轮次（刷新才恢复）。
   *
   * 判定用轮次位置而不是时间：alignToHistory 让实时轮次编号等于"已终结历史轮次数 + 1"，
   * 所以 `settledCount >= liveTurnNo` 恰好等价于"持久化已经接管这一轮"。判定必须在
   * alignToHistory 之前做，因为它会重编号实时轮次。
   */
  const load = (sessionId: string): Promise<void> =>
    fetchSessionTrajectory(sessionId)
      .then((dto) => applyLoadedTrajectory(dto, sessionId, setView, setLoadedFor))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '加载轨迹失败')
      })

  /** 当前会话尚未加载成功时，排一次微任务读取持久化轨迹（避免在 effect 体内同步 setState）。 */
  function loadTrajectoryOnce(): (() => void) | undefined {
    if (!activeSessionId) return undefined
    if (loadedFor === activeSessionId) return undefined
    const handle = setTimeout(() => {
      void load(activeSessionId)
    }, 0)
    return () => clearTimeout(handle)
  }

  useEffect(loadTrajectoryOnce, [activeSessionId, loadedFor])

  /* 展示轮次 = 历史轮次 + 实时轮次（流式进行中，或流刚结束但持久化重拉尚未落地）；
     时钟由 1s 跳秒驱动（不在 render/useMemo 里直接调 Date.now） */
  const [nowTick, setNowTick] = useState(0)

  /** 流式期间每秒跳秒，驱动实时轮次耗时与跟随尾部（不在 render/useMemo 里直接读 Date.now）。 */
  function tickWhileStreaming(): (() => void) | undefined {
    if (!streaming) return undefined
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }

  useEffect(tickWhileStreaming, [streaming])

  const displayTurns = useMemo(
    () => buildDisplayTurns(view, hasLiveTurn, liveTurns, nowTick),
    [view, hasLiveTurn, liveTurns, nowTick]
  )

  /* 选中解析必须在 displayTurns（历史 + 实时）上做：流式期间实时轮次不在 view 里。 */
  const selectedRecord = useMemo(
    () => findRecord(displayTurns, selectedId),
    [displayTurns, selectedId]
  )
  const selectedRequest = useMemo(
    () => (selectedRecord ? undefined : findRequest(displayTurns, selectedId)),
    [displayTurns, selectedId, selectedRecord]
  )
  const selectedCompaction =
    selectedId && view?.compaction?.id === selectedId ? findCompaction(view) : undefined
  const inspectorOpen = Boolean(selectedRecord || selectedRequest || selectedCompaction)

  /* 检查器 Esc 关闭（与 × 等价，设计文档承诺的交互）。
     只在检查器打开时监听，避免常驻键盘钩子；泳道的 Esc 复位范围选择由泳道自己处理。 */
  /** 检查器打开时监听 Esc 关闭（忽略可编辑元素内的 Esc）；返回解绑函数。 */
  function listenInspectorEscape(): (() => void) | undefined {
    if (!inspectorOpen) return undefined
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      /* 输入框/可编辑元素里的 Esc 属于该控件自己（清空、取消输入），不该关面板。
         没有这条守卫时，在搜索框里按 Esc 会误关检查器。 */
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable]') !== null
      ) {
        return
      }
      setSelectedId(undefined)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }

  useEffect(listenInspectorEscape, [inspectorOpen])

  /* 流式结束后必须重拉：中途取到的历史快照必然缺少终态、token 与请求子记录，
     以持久化数据为准，否则页面会停在"没有结束标记"的中间态。
     终态交接由 load 内部的"已终结轮次数 ≥ 实时轮次号"判定完成，与本次 effect 的时序无关；
     重拉失败则保留实时轮次——宁可展示内存里的真实投影，也不退回旧快照或空态。
     用 ref 记录"本会话曾进入流式"，避免在 effect 里同步 setState 引发级联渲染。 */
  const streamedSessionRef = useRef<string | null>(null)

  /** 流结束时重拉轨迹：本会话曾进入流式，则由持久化数据接管实时投影。 */
  function reloadTrajectoryAfterStream(): void {
    if (streaming) {
      streamedSessionRef.current = streamingSessionId
      return
    }
    const streamed = streamedSessionRef.current
    if (streamed === null) return
    streamedSessionRef.current = null
    void load(streamed)
  }

  useEffect(reloadTrajectoryAfterStream, [streaming, streamingSessionId, activeSessionId])

  const hasContent = displayTurns.length > 0
  const showLoading = loading && !hasLiveTurn

  /* 跟随尾部：流式进行中内容增长自动贴底；用户上滚暂停、回到底部附近恢复（含阈值与复位语义） */
  const { containerRef: ledgerScrollRef, onScroll: handleLedgerScroll } = useFollowTail({
    active: streaming,
    contentKey: displayTurns,
  })

  /** 加载失败重试：清空错误并重拉当前会话轨迹。 */
  function retryLoadTrajectory(): void {
    setError(null)
    if (activeSessionId) void load(activeSessionId)
  }

  /** 记录表选中一行：带上 tab 停留该详情，再次点击同一行（无 tab）则取消选中。 */
  function handleLedgerSelect(id: string, tab?: string): void {
    setSelectedTab(tab)
    setSelectedId((cur) => (cur === id && tab === undefined ? undefined : id))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-4 sm:px-6">
        <div className="mx-auto w-full max-w-[1080px]">
          <BackLink label="返回聊天" onClick={onBack} />
        </div>
      </div>

      {showLoading && (
        <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">
          正在加载会话轨迹…
        </div>
      )}

      {/* 有实时轮次时即使重拉失败也照常展示记录表：内存里的实时投影是真实数据，
          不能因为一次取数失败就把正在进行的轨迹换成报错页 */}
      {!showLoading && error !== null && !hasLiveTurn && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-sm text-danger-text">{error}</p>
          <button
            type="button"
            onClick={retryLoadTrajectory}
            className="cursor-pointer text-xs text-brand-text hover:underline"
          >
            重试
          </button>
        </div>
      )}

      {!showLoading && (error === null || hasLiveTurn) && !hasContent && (
        <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">
          该会话暂无可回放的轨迹记录。
        </div>
      )}

      {!showLoading && (error === null || hasLiveTurn) && hasContent && (
        <>
          {/* 页头统计：累计 token / 活动耗时 / 会话跨度（仅历史视图有合计口径） */}
          {view !== null && (
            <div className="border-b border-border px-5 py-2.5 sm:px-6">
              <div className="mx-auto flex w-full max-w-[1080px] items-center gap-4 text-xs">
                <span className="text-foreground-muted">
                  <span className="font-semibold tabular-nums text-foreground">
                    {view.totalTokens === null
                      ? '未采集'
                      : view.totalTokens.toLocaleString('en-US')}
                  </span>{' '}
                  累计 token
                  {view.subAgentTokens > 0 &&
                    `（含子 Agent ${view.subAgentTokens.toLocaleString('en-US')}）`}
                </span>
                <span className="text-foreground-muted">
                  <span className="font-semibold tabular-nums text-foreground">
                    {(view.activeMs / 1000).toFixed(1)} s
                  </span>{' '}
                  活动耗时
                </span>
                <span className="text-foreground-muted">
                  <span className="font-semibold tabular-nums text-foreground">
                    {Math.floor(view.spanMs / 60000)} m {Math.round((view.spanMs % 60000) / 1000)} s
                  </span>{' '}
                  会话跨度
                </span>
                <span className="ml-auto text-foreground-faint">{view.title}</span>
              </div>
            </div>
          )}

          {/* 工具条：搜索 */}
          <div className="border-b border-border px-5 py-2 sm:px-6">
            <div className="mx-auto flex w-full max-w-[1080px] items-center gap-3">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜索轨迹"
                aria-label="搜索轨迹"
                className="w-[260px] rounded-md border border-control-border bg-input px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <TrajectoryTimeline
            turns={displayTurns}
            compaction={view?.compaction}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((cur) => (cur === id ? undefined : id))}
            onRangeFocus={setFocusIds}
          />

          {/* relative + absolute：检查器**覆盖**在表格右侧，不参与布局——
              表格宽度不受影响，长文本不再因面板打开而被截断 */}
          <div className="relative flex min-h-0 flex-1">
            <div
              ref={ledgerScrollRef}
              onScroll={handleLedgerScroll}
              data-testid="trajectory-ledger-scroll"
              className="min-w-0 flex-1 overflow-y-auto px-5 pb-16 sm:px-6"
            >
              <div className="mx-auto w-full max-w-[1080px]">
                <TrajectoryLedger
                  turns={displayTurns}
                  compaction={view?.compaction}
                  /* 实时轮次还在展示时不得声称会话已结束：会话终态只代表"上一次运行"的终态 */
                  sessionEnd={hasLiveTurn ? undefined : view?.sessionEnd}
                  filterText={filter}
                  selectedId={selectedId}
                  onSelect={handleLedgerSelect}
                  focusIds={focusIds}
                />
              </div>
            </div>
            {inspectorOpen && (
              <TrajectoryInspector
                className="absolute inset-y-0 right-0 z-20"
                record={selectedRecord}
                request={selectedRequest}
                compaction={selectedCompaction}
                turnLabel={turnLabelOf(displayTurns, selectedId)}
                initialTab={selectedTab}
                onSelectRecord={(id) => setSelectedId(id)}
                onClose={() => setSelectedId(undefined)}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
