import { beforeEach, describe, expect, it } from 'vitest'

import { SSE_EVENT_TYPES, type ParsedSSEEvent } from '@/types/events'
import { useTrajectoryStore } from '../trajectory-store'

/** 构造一条 SSE 事件（类型断言集中在测试边界）。 */
function sse(eventType: string, data: unknown): ParsedSSEEvent {
  return { eventType, data } as ParsedSSEEvent
}

describe('trajectory-store：SSE 事件 → 实时轨迹投影', () => {
  beforeEach(() => {
    useTrajectoryStore.getState().reset()
  })

  it('用户发送即开轮；reason/token 累积到当前步骤', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('帮我调研红豆年糕')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's1', trace_id: 't1' })
    )
    store.applyEvent(sse(SSE_EVENT_TYPES.REASON, { content: '先搜资料', step: 1, timestamp: 1 }))
    store.applyEvent(sse(SSE_EVENT_TYPES.TOKEN, { content: '已整理' }))

    const turns = useTrajectoryStore.getState().liveTurns
    expect(turns).toHaveLength(1)
    expect(turns[0]?.records[0]?.kind).toBe('user')
    expect(turns[0]?.records[0]?.summary).toBe('帮我调研红豆年糕')
    const step = turns[0]?.records.find((r) => r.kind === 'call')
    expect(step?.thinking).toBe('先搜资料')
    expect(step?.reply).toBe('已整理')
    expect(step?.status).toBe('running')
  })

  it('card 事件合成一行「等待审批」：interrupting 工具没有 tool_start/tool_result，不合成则整行缺失', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('把文档分享给张三')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's1', trace_id: 't1' })
    )
    store.applyEvent(
      sse(SSE_EVENT_TYPES.CARD, {
        interaction_id: 'call_9',
        status: 'pending',
        questions: [
          { id: 'q1', text: '确认分享给张三？', options: ['同意', '拒绝'], select: 'single' },
        ],
      })
    )

    const records = useTrajectoryStore.getState().liveTurns[0]?.records ?? []
    const approval = records.find((r) => r.name === 'approval')
    expect(approval).toBeDefined()
    // id 用 interaction_id（就是 callId）：与持久化侧按 callId 重建出的行同源
    expect(approval?.id).toBe('call_9')
    expect(approval?.kind).toBe('tool')
    expect(approval?.status).toBe('interrupt')
    expect(approval?.summary).toBe('确认分享给张三？')

    // 同一 interaction 重复到达不得成两行；已作答的 card 不再合成
    store.applyEvent(
      sse(SSE_EVENT_TYPES.CARD, {
        interaction_id: 'call_9',
        status: 'pending',
        questions: [{ id: 'q1', text: '确认分享给张三？', options: ['同意'], select: 'single' }],
      })
    )
    store.applyEvent(
      sse(SSE_EVENT_TYPES.CARD, {
        interaction_id: 'call_9',
        status: 'answered',
        questions: [{ id: 'q1', text: '确认分享给张三？', options: ['同意'], select: 'single' }],
      })
    )
    const after = useTrajectoryStore.getState().liveTurns[0]?.records ?? []
    expect(after.filter((r) => r.name === 'approval')).toHaveLength(1)
  })

  it('settleIncomplete 把仍 running 的记录收成 incomplete（五种流结束路径共用）', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('查一下')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's1', trace_id: 't1' })
    )
    store.applyEvent(
      sse(SSE_EVENT_TYPES.TOOL_START, { tool_name: 'web_search', call_id: 'c1', params: null })
    )
    // 用户点停止：SSE 上不会有「你自己刚打断」的服务端事件，只能本地收尾
    store.settleIncomplete()

    const records = useTrajectoryStore.getState().liveTurns[0]?.records ?? []
    expect(records.find((r) => r.name === 'web_search')?.status).toBe('incomplete')
    // 已定稿的记录不受影响
    expect(records.find((r) => r.kind === 'user')?.status).toBeUndefined()
  })

  it('工具开始为 running，结果到达后定稿并带客户端计时耗时', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('查一下')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's1', trace_id: 't1' })
    )
    store.applyEvent(
      sse(SSE_EVENT_TYPES.TOOL_START, {
        tool_name: 'web_search',
        call_id: 'c1',
        params: { q: 'x' },
      })
    )
    let tool = useTrajectoryStore.getState().liveTurns[0]?.records.find((r) => r.kind === 'tool')
    expect(tool?.status).toBe('running')
    expect(tool?.durationMs).toBeUndefined()

    store.applyEvent(
      sse(SSE_EVENT_TYPES.TOOL_RESULT, {
        tool_name: 'web_search',
        call_id: 'c1',
        content: '5 条结果',
      })
    )
    tool = useTrajectoryStore.getState().liveTurns[0]?.records.find((r) => r.kind === 'tool')
    expect(tool?.status).toBe('success')
    expect(tool?.result).toBe('5 条结果')
    expect(typeof tool?.durationMs).toBe('number')
  })

  it('llm_retry 状态把当前步骤的尝试标失败并开新尝试', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('重试一下')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's1', trace_id: 't1' })
    )
    store.applyEvent(sse(SSE_EVENT_TYPES.REASON, { content: '想', step: 1, timestamp: 1 }))
    store.applyEvent(
      sse(SSE_EVENT_TYPES.STATUS, {
        content: '空响应重试',
        code: 'llm_empty_response_retry',
        attempt: 2,
        max_attempts: 3,
      })
    )
    const step = useTrajectoryStore.getState().liveTurns[0]?.records.find((r) => r.kind === 'call')
    expect(step?.attempts).toHaveLength(1)
    expect(step?.attempts?.[0]?.attempt).toBe('2/3')
    expect(step?.attempts?.[0]?.status).toBe('running')
  })

  it('DONE 写入轮次结束标记并结束流式', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('结束这轮')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's1', trace_id: 't1' })
    )
    store.applyEvent(sse(SSE_EVENT_TYPES.TOKEN, { content: '答' }))
    store.applyEvent(sse(SSE_EVENT_TYPES.DONE, { tokens_used: 9362, session_id: 's1' }))

    const state = useTrajectoryStore.getState()
    expect(state.streamingSessionId).toBeNull()
    const last = state.liveTurns[0]?.records.at(-1)
    expect(last?.kind).toBe('turn-end')
    expect(last?.summary).toContain('轮次 1 结束')
  })

  it('序号按展示顺序递增', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('一轮')
    store.applyEvent(sse(SSE_EVENT_TYPES.TOKEN, { content: 'a' }))
    store.applyEvent(
      sse(SSE_EVENT_TYPES.TOOL_START, { tool_name: 'web_search', call_id: 'c1', params: null })
    )

    const seqs = useTrajectoryStore.getState().liveTurns[0]?.records.map((r) => r.seq)
    // 单轮内的临时序号；跨轮续接由视图按已终结历史统一对齐（见 alignToHistory）
    expect(seqs).toEqual([1, 2, 3])
  })

  it('实时轮次号续接已终结的历史轮次，不再从 1 重来', () => {
    useTrajectoryStore.getState().beginUserTurn('还在跑的这轮')
    // 视图加载到历史：本轮之前已有 2 轮终结 → 进行中的这轮就是第 3 轮
    useTrajectoryStore.getState().alignToHistory({ turnBase: 2 })
    expect(useTrajectoryStore.getState().liveTurns[0]?.turn).toBe(3)

    // 该轮结束、重拉历史后基准推进到 3 → 下一轮续接为 4
    useTrajectoryStore.getState().alignToHistory({ turnBase: 3 })
    useTrajectoryStore.getState().beginUserTurn('下一轮')
    expect(useTrajectoryStore.getState().liveTurns[0]?.turn).toBe(4)
  })

  it('新一轮只保留当前进行中的一轮，不累积已结束轮次（否则会与历史重复）', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('第一轮')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.TOOL_START, { tool_name: 'web_search', call_id: 'c1', params: null })
    )
    store.applyEvent(sse(SSE_EVENT_TYPES.DONE, { tokens_used: 1, session_id: 's1' }))
    store.beginUserTurn('第二轮')

    const state = useTrajectoryStore.getState()
    expect(state.liveTurns).toHaveLength(1)
    expect(state.liveTurns[0]?.records[0]?.summary).toBe('第二轮')
    // 上一轮遗留的进行中计时起点不得跨轮残留
    expect(state.recordStartTimes).toEqual({})
  })

  it('步骤摘要跟随回答增长：作答期间记录行不再停在思考的第一句', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('查一下')
    store.applyEvent(sse(SSE_EVENT_TYPES.REASON, { content: '先想一下', step: 1, timestamp: 1 }))

    // 只有思考时摘要取思考首行
    const stepOf = () =>
      useTrajectoryStore.getState().liveTurns[0]?.records.find((r) => r.kind === 'call')
    expect(stepOf()?.summary).toBe('先想一下')

    // 回答开始后摘要改取回答首行，并随 token 持续增长（与持久化投影同口径）
    store.applyEvent(sse(SSE_EVENT_TYPES.TOKEN, { content: '第一段：' }))
    expect(stepOf()?.summary).toBe('第一段：')
    store.applyEvent(sse(SSE_EVENT_TYPES.TOKEN, { content: '我先识别意图' }))
    expect(stepOf()?.summary).toBe('第一段：我先识别意图')
    // 思考内容仍然保留在记录里（检查器可查）
    expect(stepOf()?.thinking).toBe('先想一下')
  })

  it('工具失败摘要带错误首行，与持久化投影一致', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('建文档')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.TOOL_START, { tool_name: 'lark_doc_create', call_id: 'c1', params: null })
    )
    store.applyEvent(
      sse(SSE_EVENT_TYPES.TOOL_RESULT, {
        tool_name: 'lark_doc_create',
        call_id: 'c1',
        content: '',
        error: '403 无权限\n请检查授权',
      })
    )

    const tool = useTrajectoryStore.getState().liveTurns[0]?.records.find((r) => r.kind === 'tool')
    expect(tool?.status).toBe('error')
    expect(tool?.summary).toBe('lark_doc_create 失败：403 无权限')
  })

  it('clearLiveTurns 丢弃实时轮次并解绑会话归属', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('一轮', 's1')
    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's1', trace_id: 't1' })
    )
    expect(useTrajectoryStore.getState().liveSessionId).toBe('s1')

    useTrajectoryStore.getState().clearLiveTurns()

    const state = useTrajectoryStore.getState()
    expect(state.liveTurns).toEqual([])
    expect(state.liveSessionId).toBeNull()
    expect(state.recordStartTimes).toEqual({})
  })

  it('会话归属由 beginUserTurn 已知值兜底，START 受理后覆盖为权威值', () => {
    const store = useTrajectoryStore.getState()
    store.beginUserTurn('新会话首轮', null)
    expect(useTrajectoryStore.getState().liveSessionId).toBeNull()

    store.applyEvent(
      sse(SSE_EVENT_TYPES.START, { request_id: 'r1', session_id: 's9', trace_id: 't1' })
    )
    expect(useTrajectoryStore.getState().liveSessionId).toBe('s9')
  })
})
