import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 会话 API：隔离 store 的网络依赖
const mockFetchSessions = vi.hoisted(() => vi.fn())
const mockFetchSession = vi.hoisted(() => vi.fn())
vi.mock('@/services/api/session', () => ({
  fetchSessions: mockFetchSessions,
  fetchSession: mockFetchSession,
}))

import { useChatStore } from '../chat-store'
import type { CardSectionData } from '@/types/chat'
import { normalizeSections } from '@/components/chat/messageSections'

function pendingCard(id = 'call_1'): CardSectionData {
  return {
    interaction_id: id,
    status: 'pending',
    questions: [{ id: 'q1', text: '确认？', options: ['是', '否'], select: 'single' }],
    answers: null,
  }
}

// 取消息里第一张卡片 section
function cardSectionOf(messages: ReturnType<typeof useChatStore.getState>['messages']) {
  for (const m of messages) {
    for (const s of m.sections ?? []) {
      if (s.type === 'card') return s.card
    }
  }
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.setState({
    messages: [],
    pendingSections: [],
    cardSubmission: null,
    isStreaming: false,
    sentAt: 0,
    activeSessionId: null,
    sessions: [],
    nextCursor: '',
    sessionsLoading: false,
  })
})

describe('ask-card store', () => {
  it('card 事件作为 section 挂到在途消息，纯卡片轮 finalize 后也提交', () => {
    useChatStore.getState().setPendingCard(pendingCard())
    useChatStore.getState().finalizeStreamingText()

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(cardSectionOf(messages)?.interaction_id).toBe('call_1')
  })

  it('markSent → 普通消息 finalize 落库带 run_started_at（流式起点一致，不跳变）', () => {
    // 前端发出瞬间打点
    useChatStore.getState().markSent()
    const sentAt = useChatStore.getState().sentAt
    expect(sentAt).toBeGreaterThan(0)

    // 一次普通（非卡片）提交
    useChatStore.setState({
      pendingSections: [{ type: 'content', content: '最终回答', timestamp: 0 }],
    })
    useChatStore.getState().finalizeStreamingText()

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0].meta?.run_started_at).toBe(sentAt)
  })

  it('startStreaming 正常清在途状态（无 answerTarget flag）', () => {
    useChatStore.setState({ pendingSections: [{ type: 'content', content: 'x', timestamp: 0 }] })
    useChatStore.getState().startStreaming('req', 'sess')
    expect(useChatStore.getState().pendingSections).toHaveLength(0)
  })

  it('markCardAnswered 原地改卡片 section status + 写 answers', () => {
    useChatStore.getState().setPendingCard(pendingCard())
    useChatStore.getState().finalizeStreamingText()

    const answers = { q1: { kind: 'option' as const, value: '是' } }
    useChatStore.getState().markCardAnswered('call_1', answers)

    const card = cardSectionOf(useChatStore.getState().messages)
    expect(card?.status).toBe('answered')
    expect(card?.answers).toEqual(answers)
  })

  it('markCardRefused 把卡片 section 置为 refused', () => {
    useChatStore.getState().setPendingCard(pendingCard())
    useChatStore.getState().finalizeStreamingText()

    useChatStore.getState().markCardRefused('call_1')
    expect(cardSectionOf(useChatStore.getState().messages)?.status).toBe('refused')
  })

  it('提交状态按 submitting → accepted → DONE 持久化流转', () => {
    useChatStore.getState().setPendingCard(pendingCard())
    useChatStore.getState().finalizeStreamingText()
    const answers = { q1: { kind: 'option' as const, value: '是' } }

    useChatStore.getState().beginCardSubmission('call_1', { answers })
    expect(useChatStore.getState().cardSubmission?.state).toBe('submitting')
    expect(cardSectionOf(useChatStore.getState().messages)?.status).toBe('pending')

    useChatStore.getState().acceptCardSubmission()
    expect(useChatStore.getState().cardSubmission?.state).toBe('accepted')
    expect(cardSectionOf(useChatStore.getState().messages)?.status).toBe('pending')

    useChatStore.getState().completeCardSubmission()
    expect(cardSectionOf(useChatStore.getState().messages)?.status).toBe('answered')
    expect(cardSectionOf(useChatStore.getState().messages)?.answers).toEqual(answers)
    expect(useChatStore.getState().cardSubmission).toBeNull()
  })

  it('提交失败保持 pending、保留答案并清理半截续跑', () => {
    const answers = { q1: { kind: 'option' as const, value: '是' } }
    useChatStore.getState().setPendingCard(pendingCard())
    useChatStore.getState().finalizeStreamingText()
    useChatStore.getState().beginCardSubmission('call_1', { answers })
    useChatStore.setState({
      pendingSections: [{ type: 'content', content: '半截内容', timestamp: 0 }],
      isStreaming: true,
    })

    useChatStore.getState().failCardSubmission('连接失败')
    expect(cardSectionOf(useChatStore.getState().messages)?.status).toBe('pending')
    expect(useChatStore.getState().pendingSections).toHaveLength(0)
    expect(useChatStore.getState().cardSubmission).toMatchObject({
      state: 'error',
      answers,
      error: '连接失败',
    })
  })

  it('answer 续跑并进卡片消息（卡片在中间），不新建消息', () => {
    // 卡片消息 [reason, card]
    useChatStore.setState({
      pendingSections: [
        {
          type: 'reason',
          items: [{ itemType: 'step', index: 1, content: '提问思考' }],
          timestamp: 0,
        },
        { type: 'card', card: pendingCard(), timestamp: 0 },
      ],
    })
    useChatStore.getState().finalizeStreamingText()

    // 用户确认 → 卡片置 answered（合并目标从消息推导）
    useChatStore.getState().markCardAnswered('call_1', { q1: { kind: 'option', value: '是' } })
    useChatStore.setState({
      pendingSections: [
        {
          type: 'reason',
          items: [{ itemType: 'step', index: 2, content: '续跑思考' }],
          timestamp: 0,
        },
        { type: 'content', content: '已确认', timestamp: 0 },
      ],
    })
    useChatStore.getState().finalizeStreamingText()

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1) // 不新建消息
    const types = messages[0].sections?.map((s) => s.type)
    expect(types).toEqual(['reason', 'card', 'reason', 'content']) // 卡片在中间
  })

  it('二次提问：answer 续跑出现新卡片 B，finalize 后保留在同一条消息（并入 A）', () => {
    // 卡片 A 消息
    useChatStore.setState({
      pendingSections: [
        {
          type: 'reason',
          items: [{ itemType: 'step', index: 1, content: '提问思考' }],
          timestamp: 0,
        },
        { type: 'card', card: pendingCard('call_A'), timestamp: 0 },
      ],
    })
    useChatStore.getState().finalizeStreamingText()
    useChatStore.getState().markCardAnswered('call_A', { q1: { kind: 'option', value: '是' } })

    // answer 续跑：内容 + 二次提问卡片 B（pending）——旧实现 filter 掉所有 card，B 会丢
    useChatStore.setState({
      pendingSections: [
        { type: 'content', content: '还需要确认', timestamp: 0 },
        { type: 'card', card: pendingCard('call_B'), timestamp: 0 },
      ],
    })
    useChatStore.getState().finalizeStreamingText()

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1) // 并入 A，不新建消息
    const sections = messages[0].sections ?? []
    const types = sections.map((s) => s.type)
    expect(types).toEqual(['reason', 'card', 'content', 'card']) // 卡片 B 保留
    const cardB = sections[sections.length - 1]
    expect(cardB.type === 'card' && cardB.card.interaction_id).toBe('call_B')
    expect(cardB.type === 'card' && cardB.card.status).toBe('pending') // 可作答

    const normalized = normalizeSections(sections, { isStreaming: false })
    expect(normalized).toHaveLength(1)
    expect(normalized[0].type).toBe('process')
    if (normalized[0].type === 'process') {
      expect(normalized[0].steps.map((step) => step.kind)).toEqual([
        'think',
        'approval',
        'narration',
        'approval',
      ])
    }
  })

  it('answer 完整流程：确认(answered) → START → 续跑 finalize 从最后一条消息恢复合并目标', () => {
    // 提交卡片消息 [reason, card(pending)]
    useChatStore.setState({
      pendingSections: [
        {
          type: 'reason',
          items: [{ itemType: 'step', index: 1, content: '提问思考' }],
          timestamp: 0,
        },
        { type: 'card', card: pendingCard(), timestamp: 0 },
      ],
    })
    useChatStore.getState().finalizeStreamingText()

    // 用户确认 → 卡片置 answered（乐观）
    useChatStore.getState().markCardAnswered('call_1', { q1: { kind: 'option', value: '是' } })
    // answer SSE 的 START 事件 → startStreaming 正常清在途状态
    useChatStore.getState().startStreaming('req', 'sess')

    // 续跑流
    useChatStore.setState({
      pendingSections: [{ type: 'content', content: '已确认', timestamp: 0 }],
    })
    useChatStore.getState().finalizeStreamingText()

    // 合并进卡片消息（目标从最后一条消息的 answered 卡片推导，不依赖瞬态 flag）
    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1)
    const types = messages[0].sections?.map((s) => s.type)
    expect(types).toEqual(['reason', 'card', 'content'])
  })

  it('续跑目标从消息推导：普通新消息（最后一条无卡片）不合并', () => {
    // 交互结束后：messages = [卡片消息(answered)]
    useChatStore.setState({
      pendingSections: [
        { type: 'card', card: { ...pendingCard(), status: 'answered' }, timestamp: 0 },
      ],
    })
    useChatStore.getState().finalizeStreamingText()
    // 用户又发新消息，agent 回复
    useChatStore.setState({
      messages: [
        ...useChatStore.getState().messages,
        { id: 'u', role: 'user', content: '再来', timestamp: 0 },
      ],
      pendingSections: [{ type: 'content', content: '新回复', timestamp: 0 }],
    })
    useChatStore.getState().finalizeStreamingText()

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(3) // 卡片消息 + user + 新 assistant（不并进卡片）
    expect(messages[2].sections?.map((s) => s.type)).toEqual(['content'])
  })

  it('switchSession 恢复映射带卡片 section（刷新后可扫 pending）', async () => {
    mockFetchSession.mockResolvedValueOnce({
      id: 'sess_1',
      messages: [
        {
          role: 'assistant',
          content: null,
          sections: [{ type: 'card', card: pendingCard('call_restore'), timestamp: 0 }],
          timestamp: 123,
        },
      ],
    })

    await useChatStore.getState().switchSession('sess_1')

    const messages = useChatStore.getState().messages
    expect(cardSectionOf(messages)?.interaction_id).toBe('call_restore')
  })
})
