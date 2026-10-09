import { create } from 'zustand'
import type {
  CardSectionData,
  CardSubmissionState,
  DisplayMessage,
  MessageSection,
} from '@/types/chat'
import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'
import { findCardMergeTarget, mergeContinuation } from '@/lib/card-merge'
import { isReasonEvent, isTokenEvent, isToolResultEvent, isToolStartEvent } from '@/types/events'
import type { ErrorEvent, SubAgentEnvelopePayload } from '@/types/events'
import type { SessionSummary } from '@/services/api/session'
import { fetchSessions, fetchSession } from '@/services/api/session'
import { extractErrorMessage } from '@/lib/errors'
import {
  applyReasonStep,
  applyToken,
  applyToolFail,
  applyToolResult,
  applyToolStart,
  settleIncompleteTools as settleSectionsIncomplete,
} from '@/components/chat/streamSections'
import { normalizePersistedSections } from '@/components/chat/processSections'

// applyInnerEvent：子 Agent 内层事件（信封 event_type + event）复用主流程组装语义。
// 未知类型/缺字段安全忽略（SSE payload 来自后端，宁可跳过不可渲染异常）。
function applyInnerEvent(
  sections: MessageSection[],
  eventType: string,
  event: unknown
): MessageSection[] {
  switch (eventType) {
    case 'token':
      return isTokenEvent(event) ? applyToken(sections, event.content) : sections
    case 'reason':
      return isReasonEvent(event) ? applyReasonStep(sections, event.step, event.content) : sections
    case 'tool_start':
      return isToolStartEvent(event)
        ? applyToolStart(sections, event.call_id, event.tool_name, event.params ?? undefined)
        : sections
    case 'tool_result':
      // error 非空 = 工具失败（与主流程同语义）
      if (!isToolResultEvent(event)) return sections
      return event.error
        ? applyToolFail(sections, event.call_id, event.error)
        : applyToolResult(sections, event.call_id, event.content)
    default:
      return sections
  }
}

interface ChatState {
  messages: DisplayMessage[]
  status: string | null
  isStreaming: boolean
  streamingStartedAt: number
  /** 前端发起本轮请求的时刻（send/answer/retry 入口打点），流式总耗时的真实起点 */
  sentAt: number
  requestId: string | null
  sessionId: string | null
  error: ErrorEvent | null
  pendingSections: MessageSection[]
  cardSubmission: CardSubmissionState | null
  /** 会话导航代次：新建/切换时递增，通知流控制器同步失效当前连接。 */
  streamNavigationEpoch: number

  // 会话侧栏列表状态
  sessions: SessionSummary[]
  nextCursor: string
  sessionsLoading: boolean
  sessionsError: string | null
  activeSessionId: string | null
}

interface ChatActions {
  addUserMessage: (content: string) => void
  markSent: () => void
  startStreaming: (requestId: string, sessionId: string) => void
  appendToken: (content: string) => void
  finalizeStreamingText: (terminalStatus?: 'cancelled') => void
  setStatus: (content: string | null) => void
  setError: (error: ErrorEvent) => void
  clearError: () => void
  ensureThinkingBlock: () => void
  appendReasonStep: (step: number, content: string) => void
  startToolCall: (callId: string, toolName: string, params?: Record<string, unknown>) => void
  completeToolCall: (callId: string, result: string) => void
  failToolCall: (callId: string, error: string) => void
  setPendingCard: (card: CardSectionData) => void
  appendSubAgentEvent: (env: SubAgentEnvelopePayload) => void
  settleIncompleteTools: () => void
  markCardAnswered: (interactionId: string, answers: Record<string, QuestionCardAnswer>) => void
  markCardRefused: (interactionId: string) => void
  beginCardSubmission: (
    interactionId: string,
    payload: {
      answers?: Record<string, QuestionCardAnswer> | undefined
      refused?: boolean | undefined
    }
  ) => void
  acceptCardSubmission: () => void
  completeCardSubmission: () => void
  failCardSubmission: (error: string) => void
  stopStreaming: (terminalStatus?: 'cancelled') => void
  reset: () => void

  // 会话侧栏 actions
  loadSessions: () => Promise<void>
  loadMoreSessions: () => Promise<void>
  switchSession: (sessionId: string) => Promise<void>
  newSession: () => void
}

const initialState: ChatState = {
  messages: [],
  status: null,
  isStreaming: false,
  streamingStartedAt: 0,
  sentAt: 0,
  requestId: null,
  sessionId: null,
  error: null,
  pendingSections: [],
  cardSubmission: null,
  streamNavigationEpoch: 0,
  sessions: [],
  nextCursor: '',
  sessionsLoading: false,
  sessionsError: null,
  activeSessionId: null,
}

/**
 * 会话级状态复位：清空消息/流/卡片/错误并递增导航代次（通知流控制器作废旧连接）。
 * 保留会话侧栏列表状态（sessions/nextCursor/加载态），由 extra 按场景覆盖
 * （如 switchSession 的目标会话 id）。newSession / switchSession 共用同一基线。
 */
function clearChatState(state: ChatState, extra?: Partial<ChatState>): Partial<ChatState> {
  return {
    messages: [],
    activeSessionId: null,
    sessionId: null,
    isStreaming: false,
    status: null,
    error: null,
    requestId: null,
    streamingStartedAt: 0,
    sentAt: 0,
    pendingSections: [],
    cardSubmission: null,
    streamNavigationEpoch: state.streamNavigationEpoch + 1,
    ...extra,
  }
}

export const useChatStore = create<ChatState & ChatActions>()((set, get) => ({
  ...initialState,

  addUserMessage: (content) => {
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `msg_${Date.now()}`,
          role: 'user',
          content,
          timestamp: Date.now(),
        },
      ],
    }))
  },

  // 流式总耗时的真实锚点：前端发起本轮请求的时刻（含连接/鉴权等待），而非服务端首事件
  markSent: () => {
    set({ sentAt: Date.now() })
  },

  startStreaming: (requestId, sessionId) => {
    set({
      requestId,
      sessionId,
      isStreaming: true,
      streamingStartedAt: Date.now(),
      status: null,
      error: null,
      pendingSections: [],
      activeSessionId: sessionId || get().activeSessionId,
    })
  },

  appendToken: (content) => {
    // pendingSections 是唯一数据源：token 只追加到最后一个 content section
    set((state) => ({ pendingSections: applyToken(state.pendingSections, content) }))
  },

  finalizeStreamingText: (terminalStatus) => {
    const { messages, pendingSections, sentAt } = get()
    // answer 续跑合并目标【从消息推导，不依赖瞬态 flag，与 ChatMessages streaming 渲染同逻辑】
    const mergeIdx = findCardMergeTarget(messages)
    if (mergeIdx >= 0) {
      // 续跑合并进卡片消息（卡片 section 之后），不新建消息。
      // 保留所有 section（含二次提问的新卡片）——「只要没有最终回复，不管多少轮都是一条」。
      if (pendingSections.length > 0) {
        const last = messages[mergeIdx]
        if (!last) return
        const merged = mergeContinuation(last.sections ?? [], pendingSections)
        set({
          messages: messages.map((m, i) =>
            i === mergeIdx
              ? {
                  ...m,
                  sections: merged,
                  meta: terminalStatus ? { ...m.meta, process_status: terminalStatus } : m.meta,
                }
              : m
          ),
        })
      }
      set({ pendingSections: [] })
      return
    }
    // 普通提交（含纯卡片轮：卡片已是 pendingSections 里的 type="card" section）
    if (pendingSections.length === 0) return
    set({
      messages: [
        ...messages,
        {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          sections: [...pendingSections],
          timestamp: Date.now(),
          // 保持与流式一致的起点（sentAt = 前端发出瞬间），避免完成后总耗时跳变
          meta:
            sentAt > 0 || terminalStatus
              ? {
                  ...(sentAt > 0 ? { run_started_at: sentAt } : {}),
                  ...(terminalStatus ? { process_status: terminalStatus } : {}),
                }
              : undefined,
        },
      ],
      pendingSections: [],
    })
  },

  setPendingCard: (card) => {
    // card 事件 → 作为 type="card" section 追加到在途消息
    set((state) => ({
      pendingSections: [...state.pendingSections, { type: 'card', card, timestamp: Date.now() }],
    }))
  },

  markCardAnswered: (interactionId, answers) => {
    set((state) => ({
      messages: state.messages.map((m) => ({
        ...m,
        sections: m.sections?.map((s) =>
          s.type === 'card' && s.card.interaction_id === interactionId
            ? { ...s, card: { ...s.card, status: 'answered', answers } }
            : s
        ),
      })),
    }))
  },

  markCardRefused: (interactionId) => {
    set((state) => ({
      messages: state.messages.map((m) => ({
        ...m,
        sections: m.sections?.map((s) =>
          s.type === 'card' && s.card.interaction_id === interactionId
            ? { ...s, card: { ...s.card, status: 'refused', answers: null } }
            : s
        ),
      })),
    }))
  },

  beginCardSubmission: (interactionId, payload) => {
    set({
      cardSubmission: {
        interactionId,
        state: 'submitting',
        answers: payload.answers,
        refused: payload.refused,
      },
    })
  },

  acceptCardSubmission: () => {
    set((state) => ({
      cardSubmission:
        state.cardSubmission?.state === 'submitting'
          ? { ...state.cardSubmission, state: 'accepted' }
          : state.cardSubmission,
    }))
  },

  completeCardSubmission: () => {
    const submission = get().cardSubmission
    if (!submission) return

    if (submission.refused) {
      get().markCardRefused(submission.interactionId)
    } else {
      get().markCardAnswered(submission.interactionId, submission.answers ?? {})
    }
    set({ cardSubmission: null })
  },

  failCardSubmission: (error) => {
    const submission = get().cardSubmission
    set({
      cardSubmission: submission ? { ...submission, state: 'error', error } : null,
      pendingSections: [],
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
    })
  },

  setStatus: (content) => {
    set({ status: content })
  },

  ensureThinkingBlock: () => {
    set((state) => {
      if (state.pendingSections.length === 0) {
        return { pendingSections: [{ type: 'reason', items: [], timestamp: Date.now() }] }
      }
      return {}
    })
  },

  appendReasonStep: (step, content) => {
    set((state) => ({ pendingSections: applyReasonStep(state.pendingSections, step, content) }))
  },

  startToolCall: (callId, toolName, params) => {
    set((state) => ({
      pendingSections: applyToolStart(state.pendingSections, callId, toolName, params),
    }))
  },

  completeToolCall: (callId, result) => {
    set((state) => {
      const settled = applyToolResult(state.pendingSections, callId, result)
      // 委派工具落定 → 对应 sub_agent section 收尾。返回文本尾部的 [execution_id: ...]
      // 是引擎给父 LLM 的续跑协议标记，进 UI 前剥掉（历史回放的 result_summary 本就干净）
      const summary = result.replace(/\s*\[execution_id:[^\]]+\]\s*$/, '')
      return {
        pendingSections: settled.map((s) =>
          s.type === 'sub_agent' &&
          s.items.parent_call_id === callId &&
          s.items.status === 'running'
            ? { ...s, items: { ...s.items, status: 'completed' as const, result_summary: summary } }
            : s
        ),
      }
    })
  },

  failToolCall: (callId, error) => {
    set((state) => {
      const settled = applyToolFail(state.pendingSections, callId, error)
      return {
        pendingSections: settled.map((s) =>
          s.type === 'sub_agent' &&
          s.items.parent_call_id === callId &&
          s.items.status === 'running'
            ? { ...s, items: { ...s.items, status: 'failed' as const, result_summary: error } }
            : s
        ),
      }
    })
  },

  appendSubAgentEvent: (env) => {
    set((state) => {
      const idx = state.pendingSections.findIndex(
        (s) => s.type === 'sub_agent' && s.items.parent_call_id === env.parent_call_id
      )
      if (idx < 0) {
        // 首次见到该委派：在尾部建 sub_agent section（位置 = 委派工具执行期间，时序正确）
        const section: MessageSection = {
          type: 'sub_agent',
          items: {
            agent_id: env.agent_id,
            agent_name: env.agent_name,
            execution_id: env.execution_id,
            parent_call_id: env.parent_call_id,
            sections: applyInnerEvent([], env.event_type, env.event),
            status: 'running',
          },
          timestamp: Date.now(),
        }
        return { pendingSections: [...state.pendingSections, section] }
      }
      const target = state.pendingSections[idx]
      if (!target || target.type !== 'sub_agent') return {}
      const next: MessageSection = {
        ...target,
        items: {
          ...target.items,
          sections: applyInnerEvent(target.items.sections, env.event_type, env.event),
        },
      }
      const sections = [...state.pendingSections]
      sections[idx] = next
      return { pendingSections: sections }
    })
  },

  settleIncompleteTools: () => {
    set((state) => ({
      pendingSections: settleSectionsIncomplete(state.pendingSections),
    }))
  },

  setError: (error) => {
    set({
      error,
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
    })
  },

  clearError: () => {
    set({ error: null })
  },

  stopStreaming: (terminalStatus) => {
    get().finalizeStreamingText(terminalStatus)
    set({
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
    })
  },

  reset: () => {
    set((state) => ({ ...initialState, streamNavigationEpoch: state.streamNavigationEpoch + 1 }))
  },

  // ── 会话侧栏 actions ──────────────────────────────

  loadSessions: async () => {
    set({ sessionsLoading: true, sessionsError: null })
    try {
      const data = await fetchSessions()
      set({ sessions: data.sessions, nextCursor: data.next_cursor })
    } catch (e) {
      set({ sessionsError: extractErrorMessage(e) })
    } finally {
      set({ sessionsLoading: false })
    }
  },

  loadMoreSessions: async () => {
    const { nextCursor, sessionsLoading } = get()
    if (!nextCursor || sessionsLoading) return
    set({ sessionsLoading: true, sessionsError: null })
    try {
      const data = await fetchSessions(nextCursor)
      set((state) => ({
        sessions: [...state.sessions, ...data.sessions],
        nextCursor: data.next_cursor,
      }))
    } catch (e) {
      set({ sessionsError: extractErrorMessage(e) })
    } finally {
      set({ sessionsLoading: false })
    }
  },

  switchSession: async (sessionId: string) => {
    // 立即清空会话状态，避免拉取期间渲染过期内容；epoch 递增令流控制器作废旧连接
    set((state) =>
      clearChatState(state, { activeSessionId: sessionId, sessionId, sessionsError: null })
    )

    try {
      const data = await fetchSession(sessionId)
      // 仅在仍停留在目标会话时应用结果（避免竞态下旧响应覆盖新会话）
      if (get().activeSessionId !== sessionId) return

      const messages: DisplayMessage[] = (data.messages || []).map((m, index) => ({
        id: `msg_${sessionId}_${index}_${m.timestamp}`,
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content ?? '',
        sections: m.sections ? normalizePersistedSections(m.sections) : m.sections,
        source: m.source,
        meta: m.meta,
        timestamp: m.timestamp,
      }))
      set({ messages })
    } catch (e) {
      // 仅在仍停留在目标会话时展示错误（避免竞态下错误串到新会话）
      if (get().activeSessionId === sessionId) {
        set({ sessionsError: extractErrorMessage(e) })
      }
    }
  },

  newSession: () => {
    set((state) => clearChatState(state))
  },
}))

/* store 一律不做热替换：React Fast Refresh 只重建"接受更新"的组件边界，没被重建的模块
   （如 useChatStream）会继续持有旧 store 实例，于是写入方与读取方各绑一份 state——
   表现就是实时投影不再跟随 SSE、流结束后同一轮出现两次。这里声明自接受并整页刷新，
   代价是开发期一次刷新，换来实例唯一（import.meta.hot 在生产构建中为 undefined）。 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
