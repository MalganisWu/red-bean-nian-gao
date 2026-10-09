import { act, fireEvent, render, screen } from '@testing-library/react'
import type { SessionTrajectoryDto } from '@red-bean/api-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchSessionTrajectory } from '@/services/api/trajectory'
import { SSE_EVENT_TYPES, type ParsedSSEEvent } from '@/types/events'
import { useChatStore } from '@/stores/chat-store'
import { useTrajectoryStore } from '@/stores/trajectory-store'

import { SessionTrajectoryView } from '../SessionTrajectoryView'

/* fetchSessionTrajectory 打桩为永不返回：模拟历史加载进行中 / 无历史可加载 */
vi.mock('@/services/api/trajectory', () => ({
  fetchSessionTrajectory: vi.fn(() => new Promise<never>(() => {})),
}))

/** 构造一条 SSE 事件（类型断言集中在测试边界）。 */
function sse(eventType: string, data: unknown): ParsedSSEEvent {
  return { eventType, data } as ParsedSSEEvent
}

interface ScrollBox {
  scrollTop: number
  scrollHeight: number
}

/**
 * jsdom 没有布局引擎：把滚动几何做成元素实例上的可变属性，
 * 测试按需驱动 scrollHeight（内容增长）与 scrollTop（用户滚动）。
 */
function bindScrollGeometry(el: HTMLElement, clientHeight: number): ScrollBox {
  const box: ScrollBox = { scrollTop: 0, scrollHeight: 0 }
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => box.scrollTop,
    set: (value: number) => {
      box.scrollTop = value
    },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  return box
}

/** 组装「新会话正在流式」的实时投影：已开轮 + START 受理 + 首个步骤思考中。 */
function seedLiveTurn(sessionId: string, userContent: string): void {
  useTrajectoryStore.getState().beginUserTurn(userContent)
  useTrajectoryStore
    .getState()
    .applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: sessionId, trace_id: 't1' })
    )
  useTrajectoryStore
    .getState()
    .applyEvent(sse(SSE_EVENT_TYPES.REASON, { content: '先搜资料', step: 1, timestamp: 1 }))
}

/** 等待挂载时的轨迹加载落地（effect 用 setTimeout(0) 触发）。 */
async function flushLoad(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1)
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 运行中的轨迹快照：run 容器已在运行开始落库，但这一轮尚未终结（endState=null）。 */
function unsettledTurnDto(sessionId: string): SessionTrajectoryDto {
  return {
    sessionId,
    title: '会话标题',
    turns: [
      {
        turn: 1,
        startedAt: 1_700_000_000_000,
        durationMs: 1_100,
        tokens: null,
        records: [
          {
            id: 'hist-1',
            seq: 1,
            kind: 'user',
            at: 1_700_000_000_000,
            summary: '帮我调研红豆年糕',
          },
        ],
        endState: null,
      },
    ],
    compaction: null,
    sessionEnd: null,
    totalTokens: null,
    subAgentTokens: 0,
    activeMs: 1_100,
    spanMs: 1_100,
  }
}

/** 已终结的轨迹快照：流结束后重拉拿到的形态（补齐步骤与终态）。 */
function settledTurnDto(sessionId: string): SessionTrajectoryDto {
  return {
    sessionId,
    title: '会话标题',
    turns: [
      {
        turn: 1,
        startedAt: 1_700_000_000_000,
        durationMs: 30_000,
        tokens: 3_630,
        records: [
          {
            id: 'hist-1',
            seq: 1,
            kind: 'user',
            at: 1_700_000_000_000,
            summary: '帮我调研红豆年糕',
          },
          {
            id: 'hist-2',
            seq: 2,
            kind: 'call',
            at: 1_700_000_001_000,
            summary: '先搜资料',
          },
        ],
        endState: { state: 'completed', at: 1_700_000_030_000 },
      },
    ],
    compaction: null,
    sessionEnd: { state: 'completed', at: 1_700_000_030_000 },
    totalTokens: 3_630,
    subAgentTokens: 0,
    activeMs: 30_000,
    spanMs: 30_000,
  }
}

describe('SessionTrajectoryView：空态与跟随尾部', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    /* 每个用例从干净的桩开始：默认永不返回（模拟加载中），必要时用 mockResolvedValueOnce 指定快照 */
    vi.mocked(fetchSessionTrajectory).mockReset()
    vi.mocked(fetchSessionTrajectory).mockImplementation(() => new Promise<never>(() => {}))
    useTrajectoryStore.getState().reset()
    useChatStore.setState({ activeSessionId: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('view=null 且非 live（新会话无历史）：渲染空态提示不崩溃', () => {
    render(<SessionTrajectoryView onBack={() => {}} />)

    expect(screen.getByText('该会话暂无可回放的轨迹记录。')).toBeInTheDocument()
    // 无 view 时不渲染页头统计与记录表（不出现来自历史数据的合计口径）
    expect(screen.queryByText('累计 token')).not.toBeInTheDocument()
    expect(screen.queryByTestId('trajectory-ledger-scroll')).not.toBeInTheDocument()
  })

  it('view=null 且 live（新会话直接发消息）：实时投影可见且跳秒后自动贴底', () => {
    seedLiveTurn('s-live', '帮我调研红豆年糕')
    useChatStore.setState({ activeSessionId: 's-live' })

    render(<SessionTrajectoryView onBack={() => {}} />)

    // 历史 view 未加载完成，但实时投影照常渲染；页头统计仍不出现（view 为 null）
    expect(screen.getByText('帮我调研红豆年糕')).toBeInTheDocument()
    expect(screen.getByText('先搜资料')).toBeInTheDocument()
    expect(screen.queryByText('累计 token')).not.toBeInTheDocument()

    // 跟随尾部接线：跳秒驱动内容刷新 → 记录表容器贴底
    const el = screen.getByTestId('trajectory-ledger-scroll')
    const box = bindScrollGeometry(el, 200)
    box.scrollHeight = 600
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(el.scrollTop).toBe(600)
  })

  it('跟随尾部接线：live 中用户上滚暂停，回到底部附近恢复', () => {
    seedLiveTurn('s-live', '查一下')
    useChatStore.setState({ activeSessionId: 's-live' })

    render(<SessionTrajectoryView onBack={() => {}} />)

    const el = screen.getByTestId('trajectory-ledger-scroll')
    const box = bindScrollGeometry(el, 200)
    box.scrollHeight = 600
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(el.scrollTop).toBe(600)

    // 用户上滚（距底 280px > 阈值）→ 暂停：跳秒刷新内容也不强制贴底
    box.scrollTop = 120
    fireEvent.scroll(el)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(el.scrollTop).toBe(120)

    // 回到底部附近（距离 0 ≤ 阈值）→ 恢复跟随
    box.scrollTop = 400
    fireEvent.scroll(el)
    box.scrollHeight = 900
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(el.scrollTop).toBe(900)
  })

  it('流式进行中：运行中的 run 只出现一个轮次，且不显示任何终态标记', async () => {
    /* 历史快照是在运行中途取到的：该 run 已落库但尚未终结（endState=null） */
    const inProgress: SessionTrajectoryDto = {
      sessionId: 's-live',
      title: '会话标题',
      turns: [
        {
          turn: 1,
          startedAt: 1_700_000_000_000,
          durationMs: 1_100,
          tokens: null,
          records: [
            {
              id: 'hist-1',
              seq: 1,
              kind: 'user',
              at: 1_700_000_000_000,
              summary: '帮我调研红豆年糕',
            },
          ],
          endState: null,
        },
      ],
      compaction: null,
      sessionEnd: null,
      totalTokens: null,
      subAgentTokens: 0,
      activeMs: 1_100,
      spanMs: 1_100,
    }
    vi.mocked(fetchSessionTrajectory).mockResolvedValueOnce(inProgress)
    seedLiveTurn('s-live', '帮我调研红豆年糕')
    useChatStore.setState({ activeSessionId: 's-live' })

    render(<SessionTrajectoryView onBack={() => {}} />)
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
    })

    // 回归：同一个 run 曾同时出现在历史投影与实时投影里 → 记录表出现两个「轮次 1」。
    // 历史里那条尚未终结的轮次必须被实时轮次取代（而不是并排），用户记录也只出现一次。
    expect(screen.getAllByText('轮次 1')).toHaveLength(1)
    expect(screen.getAllByText('帮我调研红豆年糕')).toHaveLength(1)
    // 回归：运行中的 run 曾被投影成"已中断"的终态，并让整场会话显示"已结束"。
    expect(screen.queryAllByText(/已中断/)).toHaveLength(0)
    expect(screen.queryAllByText(/轮次 1 结束/)).toHaveLength(0)
    expect(screen.queryAllByText(/会话结束/)).toHaveLength(0)
    // 实时内容照常可见
    expect(screen.getByText('先搜资料')).toBeInTheDocument()
  })

  it('流式作答期间记录行跟随回答增长，不在工具调用之后静止', async () => {
    seedLiveTurn('s-live', '查一下')
    useChatStore.setState({ activeSessionId: 's-live' })

    render(<SessionTrajectoryView onBack={() => {}} />)
    expect(screen.getByText('先搜资料')).toBeInTheDocument()

    /* 回归：TOKEN 只更新 reply、从不更新摘要 → 整个作答期间记录行文本一动不动，
       用户看到的是"轨迹吐完第一段就不吐了"。摘要必须与持久化投影同口径地跟随回答。 */
    act(() => {
      useTrajectoryStore.getState().applyEvent(sse(SSE_EVENT_TYPES.TOKEN, { content: '第一段：' }))
      useTrajectoryStore
        .getState()
        .applyEvent(sse(SSE_EVENT_TYPES.TOKEN, { content: '我先识别意图' }))
    })
    expect(screen.getByText('第一段：我先识别意图')).toBeInTheDocument()
  })

  it('流结束后实时轮次保留到持久化数据到位（不出现空态/加载态或重复轮次）', async () => {
    const inProgress = unsettledTurnDto('s-live')
    vi.mocked(fetchSessionTrajectory).mockResolvedValueOnce(inProgress)
    seedLiveTurn('s-live', '帮我调研红豆年糕')
    useChatStore.setState({ activeSessionId: 's-live' })

    render(<SessionTrajectoryView onBack={() => {}} />)
    await flushLoad()

    act(() => {
      useTrajectoryStore
        .getState()
        .applyEvent(sse(SSE_EVENT_TYPES.DONE, { tokens_used: 2643, session_id: 's-live' }))
    })

    /* 回归：DONE 立刻把 isLive 置假 → 实时轮次被丢弃、历史快照里又没有这一轮，
       记录表瞬间变成空态或加载态，看起来就是"轨迹没了、直接会话完毕"。 */
    expect(screen.queryByText('该会话暂无可回放的轨迹记录。')).not.toBeInTheDocument()
    expect(screen.queryByText('正在加载会话轨迹…')).not.toBeInTheDocument()
    expect(screen.getByText('先搜资料')).toBeInTheDocument()
    expect(screen.getAllByText('轮次 1')).toHaveLength(1)
    // 实时轮次仍在场时不显示会话终态标记
    expect(screen.queryAllByText(/会话结束/)).toHaveLength(0)
  })

  it('重拉到位后由持久化轮次接管：实时轮次清空，终态标记各出现一次', async () => {
    vi.mocked(fetchSessionTrajectory).mockResolvedValueOnce(unsettledTurnDto('s-fin'))
    vi.mocked(fetchSessionTrajectory).mockResolvedValueOnce(settledTurnDto('s-fin'))
    seedLiveTurn('s-fin', '帮我调研红豆年糕')
    useChatStore.setState({ activeSessionId: 's-fin' })

    render(<SessionTrajectoryView onBack={() => {}} />)
    await flushLoad()

    act(() => {
      useTrajectoryStore
        .getState()
        .applyEvent(sse(SSE_EVENT_TYPES.DONE, { tokens_used: 2643, session_id: 's-fin' }))
    })
    await flushLoad()

    expect(useTrajectoryStore.getState().liveTurns).toHaveLength(0)
    expect(screen.getAllByText('轮次 1')).toHaveLength(1)
    expect(screen.getAllByText(/轮次 1 结束/)).toHaveLength(1)
    /* 终态行改为「细规则 + 空心终态 chip」：状态由 chip 承担，正文只写「会话结束」，
       两者各出现一次——不是重复记录，也不是「结束」说两遍。 */
    expect(screen.getAllByText('会话结束')).toHaveLength(1)
    /* 「完成」是空心终态 chip 的文案：本 fixture 有轮次结束与会话结束两条终态行 → 两个。
       关键是正文不再重复状态（旧的「会话结束 · 完成」写法已移除）。 */
    expect(screen.getAllByText('完成')).toHaveLength(2)
    expect(screen.queryByText(/会话结束 · 完成/)).toBeNull()
    expect(vi.mocked(fetchSessionTrajectory)).toHaveBeenCalledTimes(2)
  })

  it('流被中止后重新打开：历史已包含该 run 时不再并列显示实时轮次（防重复）', async () => {
    /* 场景：DONE 从未到达（连接被中止 / 切会话），实时轮次一直挂在 store 里。
       此时持久化已经把这个 run 收尾，视图重挂载后必须由历史接管，而不是两条同号轮次。 */
    seedLiveTurn('s-dup', '帮我调研红豆年糕')
    useChatStore.setState({ activeSessionId: 's-dup' })
    vi.mocked(fetchSessionTrajectory).mockResolvedValue(settledTurnDto('s-dup'))

    const first = render(<SessionTrajectoryView onBack={() => {}} />)
    await flushLoad()
    first.unmount()

    render(<SessionTrajectoryView onBack={() => {}} />)
    await flushLoad()

    expect(useTrajectoryStore.getState().liveTurns).toHaveLength(0)
    expect(screen.getAllByText('轮次 1')).toHaveLength(1)
    expect(screen.getAllByText(/轮次 1 结束/)).toHaveLength(1)
  })

  it('点击记录打开检查器，Esc 关闭（与 × 等价）', async () => {
    const settled: SessionTrajectoryDto = {
      sessionId: 's-esc',
      title: '会话标题',
      turns: [
        {
          turn: 1,
          startedAt: 1_700_000_000_000,
          durationMs: 1_100,
          tokens: 120,
          records: [
            {
              id: 'esc-1',
              seq: 1,
              kind: 'user',
              at: 1_700_000_000_000,
              summary: '看详情',
            },
          ],
          endState: { state: 'completed', at: 1_700_000_001_100 },
        },
      ],
      compaction: null,
      sessionEnd: { state: 'completed', at: 1_700_000_001_100 },
      totalTokens: 120,
      subAgentTokens: 0,
      activeMs: 1_100,
      spanMs: 1_100,
    }
    vi.mocked(fetchSessionTrajectory).mockResolvedValueOnce(settled)
    useChatStore.setState({ activeSessionId: 's-esc' })

    const { container } = render(<SessionTrajectoryView onBack={() => {}} />)
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
    })

    /* 检查器根节点带 aria-label，作为"是否打开"的稳定判据 */
    const inspector = () => container.querySelector('[aria-label="记录检查器"]')
    expect(inspector()).toBeNull()

    const row = container.querySelector('[data-record-id]')
    if (row === null) throw new Error('未渲染轨迹记录行')
    fireEvent.click(row)
    expect(inspector()).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(inspector()).toBeNull()
  })
})
