import { create } from 'zustand'
import type { StateCreator } from 'zustand'
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

/**
 * 子 Agent 内层事件的分派入口：把信封里的一条 event 折进该子 Agent 的 section 列表，
 * 分派到 token/reason/tool_start/tool_result 的既有组装函数，与主流程保持同一语义。
 * 事件类型未知或字段缺失时安全跳过——载荷来自后端 SSE，宁可忽略也不能渲染出异常结构。
 *
 * @param sections - 子 Agent 当前的 section 列表，作为折叠基准。
 * @param eventType - 信封事件类型，决定分派到哪个组装函数。
 * @param event - 后端下发的内层事件载荷，类型未经收窄，按类型守卫校验。
 * @returns 折叠后的 section 列表；事件无法识别时原样返回入参。
 */
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

/** 对话主投影的只读状态切片：消息列表、流式进度、待处理 section、卡片提交态与会话侧栏列表。 */
interface ChatState {
  /** 已定稿的消息列表；流式进行中的内容先留在 pendingSections，定稿时才并入。 */
  messages: DisplayMessage[]
  /** 服务端状态提示文案（如「思考中」）；无提示时为 null。 */
  status: string | null
  /** 是否正处于流式接收中；驱动输入框的取消按钮与发送禁用态。 */
  isStreaming: boolean
  /** 本轮流式的开始时刻（毫秒）；0 表示无进行中的流。 */
  streamingStartedAt: number
  /** 前端发起本轮请求的时刻（send/answer/retry 入口打点），流式总耗时的真实起点 */
  sentAt: number
  /** 本轮请求 id；用于取消与竞态比对，非流式时为 null。 */
  requestId: string | null
  /** 当前会话 id；新会话在 START 事件前可能为 null。 */
  sessionId: string | null
  /** 最近一次流式错误事件；非空时界面展示可重试的错误态。 */
  error: ErrorEvent | null
  /** 流式在途的分段（思考、工具、卡片等），定稿后并入 messages 并清空。 */
  pendingSections: MessageSection[]
  /** 卡片提交的进行态；null 表示当前没有待提交的卡片。 */
  cardSubmission: CardSubmissionState | null
  /** 会话导航代次：新建/切换时递增，通知流控制器同步失效当前连接。 */
  streamNavigationEpoch: number

  // 会话侧栏列表状态
  /** 侧栏的会话列表（分页累积）。 */
  sessions: SessionSummary[]
  /** 会话列表下一页游标；空串表示已到末页。 */
  nextCursor: string
  /** 会话列表是否正在加载（首屏或翻页）。 */
  sessionsLoading: boolean
  /** 会话列表最近一次的失败消息；非空时侧栏展示错误。 */
  sessionsError: string | null
  /** 当前激活（高亮）的会话 id；null 表示新会话尚未落定。 */
  activeSessionId: string | null
}

/** 对话主投影对外暴露的动作集合：流式写入、卡片提交、错误处理与会话侧栏加载，供组件回调调用。 */
interface ChatActions {
  /**
   * 追加一条本地用户消息，id 与时间戳在本地生成。
   * @param content - 用户输入的消息正文，原样写入新消息的 content 字段。
   */
  addUserMessage: (content: string) => void
  /** 记录前端发出本轮请求的时刻，作为流式总耗时的真实起点。 */
  markSent: () => void
  /**
   * 开始一轮流式：记录请求/会话 id 与起点时刻，清空上一轮状态与错误。
   * @param requestId - 本轮请求 id，写入状态供取消与竞态比对使用。
   * @param sessionId - 目标会话 id，同时用于高亮当前会话；为空串时沿用已有高亮会话。
   */
  startStreaming: (requestId: string, sessionId: string) => void
  /**
   * 追加一段回答 token 到在途 section 的 content 段（末段）。
   * @param content - 本次增量回答文本，追加到在途 section 末段的 content。
   */
  appendToken: (content: string) => void
  /**
   * 把在途 section 定稿为一条消息（续跑则合并进卡片消息），并清空 pendingSections。
   * @param terminalStatus - 终态标记，为 'cancelled' 时把定稿消息标注为已取消；省略则不带终态。
   */
  finalizeStreamingText: (terminalStatus?: 'cancelled') => void
  /**
   * 设置或清除服务端状态提示文案（null 表示无提示）。
   * @param content - 要展示的状态提示文案；传 null 表示清除提示。
   */
  setStatus: (content: string | null) => void
  /**
   * 记录流式错误并结束本轮请求生命周期（停止流式、清空起点）。
   * @param error - 最近一次流式错误事件，写入 error 并驱动界面的可重试错误态。
   */
  setError: (error: ErrorEvent) => void
  /** 清除错误态，不影响进行中的流式。 */
  clearError: () => void
  /** 确保在途 section 里已有一个思考块，没有则新建空思考块。 */
  ensureThinkingBlock: () => void
  /**
   * 追加一步思考内容（序号 + 文本）到在途的 reason 段。
   * @param step - 思考步骤序号，用于在 reason 段内排序。
   * @param content - 该步思考的文本内容。
   */
  appendReasonStep: (step: number, content: string) => void
  /**
   * 工具开始：追加一条 running 的 tool section（带参数时一并记录）。
   * @param callId - 工具调用 id，用于后续结果或失败落定时定位该 section。
   * @param toolName - 工具名称，展示在 tool section 上。
   * @param params - 工具调用入参；未提供时该 section 不记录参数。
   */
  startToolCall: (callId: string, toolName: string, params?: Record<string, unknown>) => void
  /**
   * 工具成功落定，并把同 callId 的委派 section 收尾（剥掉续跑协议标记）。
   * @param callId - 成功落定的工具调用 id，用于定位对应的 tool section。
   * @param result - 工具返回文本，写入 section 作为结果展示。
   */
  completeToolCall: (callId: string, result: string) => void
  /**
   * 工具失败落定，并把同 callId 的委派 section 收尾为失败。
   * @param callId - 失败的工具调用 id，用于定位对应的 tool section。
   * @param error - 失败原因文本，写入 section 作为失败结果展示。
   */
  failToolCall: (callId: string, error: string) => void
  /**
   * 追加一张待回答卡片 section。
   * @param card - 待回答的卡片数据，作为 type="card" section 追加到在途消息。
   */
  setPendingCard: (card: CardSectionData) => void
  /**
   * 并入一条子 Agent 信封事件：按 parent_call_id 建或找 sub_agent section。
   * @param env - 子 Agent 信封载荷，携带 agent/execution 标识与内层事件。
   */
  appendSubAgentEvent: (env: SubAgentEnvelopePayload) => void
  /** 把仍处于 running 的工具 section 收尾为中断态（用于流异常结束）。 */
  settleIncompleteTools: () => void
  /**
   * 把卡片标记为已回答，并写入用户提交的答案。
   * @param interactionId - 卡片交互 id，用于定位要标记的卡片 section。
   * @param answers - 用户提交的答案，按问题 id 索引写入卡片。
   */
  markCardAnswered: (interactionId: string, answers: Record<string, QuestionCardAnswer>) => void
  /**
   * 把卡片标记为已拒绝（answers 置空）。
   * @param interactionId - 卡片交互 id，用于定位要标记为已拒绝的卡片 section。
   */
  markCardRefused: (interactionId: string) => void
  /**
   * 进入卡片提交态（submitting），记录本次提交的答案与拒绝标记。
   * @param interactionId - 本次提交对应的卡片交互 id。
   * @param payload - 提交内容，含可选答案与拒绝标记。
   */
  beginCardSubmission: (
    interactionId: string,
    payload: {
      answers?: Record<string, QuestionCardAnswer> | undefined
      refused?: boolean | undefined
    }
  ) => void
  /** 标记卡片提交已被服务端受理（submitting → accepted）。 */
  acceptCardSubmission: () => void
  /** 提交收尾：按拒绝与否落定卡片，并清空提交态。 */
  completeCardSubmission: () => void
  /**
   * 提交失败：卡片转错误态，同时结束本轮流式与请求生命周期。
   * @param error - 提交失败原因文本，写入卡片提交态供界面提示。
   */
  failCardSubmission: (error: string) => void
  /**
   * 停止流式：先定稿在途文本，再清空流式状态。
   * @param terminalStatus - 终态标记，为 'cancelled' 时把定稿消息标注为已取消；省略则不带终态。
   */
  stopStreaming: (terminalStatus?: 'cancelled') => void
  /** 复位会话级状态到初始基线，并递增导航代次以作废旧连接。 */
  reset: () => void

  // 会话侧栏 actions
  /** 拉取会话列表首屏（覆盖式）。 */
  loadSessions: () => Promise<void>
  /** 以当前游标追加下一页会话列表；无游标或正在加载时跳过。 */
  loadMoreSessions: () => Promise<void>
  /**
   * 切换会话：先清空并递增导航代次，再拉取目标会话（仅仍停留在目标时才落地）。
   * @param sessionId - 目标会话 id，用于拉取历史消息并作为高亮会话。
   */
  switchSession: (sessionId: string) => Promise<void>
  /** 开启新会话：按基线清空会话级状态。 */
  newSession: () => void
}

/** 全量初始状态：既是 store 首次创建的基线，也是 reset/clearChatState 复位的依据，改这里会同时影响两条路径。 */
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
 * 确保在途 section 里已有一个思考块，没有则新建空思考块。
 *
 * @param state - 当前 store 状态，仅在 pendingSections 为空时补一个空思考块。
 * @returns 需要写入的部分状态；已有在途 section 时返回空对象表示无变化。
 */
function withThinkingBlock(state: ChatState): Partial<ChatState> {
  if (state.pendingSections.length === 0) {
    return { pendingSections: [{ type: 'reason', items: [], timestamp: Date.now() }] }
  }
  return {}
}

/**
 * 工具成功落定，并把同 callId 的委派 section 收尾（剥掉续跑协议标记）。
 *
 * @param state - 当前 store 状态，其 pendingSections 为落定基准。
 * @param callId - 工具调用 id，用于定位并收尾同名的委派 section。
 * @param result - 工具返回文本；尾部的续跑协议标记会在进 UI 前剥除。
 * @returns 落定后的部分状态（pendingSections）。
 */
function withCompletedToolCall(
  state: ChatState,
  callId: string,
  result: string
): Partial<ChatState> {
  const settled = applyToolResult(state.pendingSections, callId, result)
  // 委派工具落定 → 对应 sub_agent section 收尾。返回文本尾部的 [execution_id: ...]
  // 是引擎给父 LLM 的续跑协议标记，进 UI 前剥掉（历史回放的 result_summary 本就干净）
  const summary = result.replace(/\s*\[execution_id:[^\]]+\]\s*$/, '')
  return {
    pendingSections: settled.map((s) =>
      s.type === 'sub_agent' && s.items.parent_call_id === callId && s.items.status === 'running'
        ? { ...s, items: { ...s.items, status: 'completed' as const, result_summary: summary } }
        : s
    ),
  }
}

/**
 * 工具失败落定，并把同 callId 的委派 section 收尾为失败。
 *
 * @param state - 当前 store 状态，其 pendingSections 为落定基准。
 * @param callId - 失败的工具调用 id，用于定位并收尾同名的委派 section。
 * @param error - 失败原因文本，写入委派 section 的 result_summary。
 * @returns 落定后的部分状态（pendingSections）。
 */
function withFailedToolCall(state: ChatState, callId: string, error: string): Partial<ChatState> {
  const settled = applyToolFail(state.pendingSections, callId, error)
  return {
    pendingSections: settled.map((s) =>
      s.type === 'sub_agent' && s.items.parent_call_id === callId && s.items.status === 'running'
        ? { ...s, items: { ...s.items, status: 'failed' as const, result_summary: error } }
        : s
    ),
  }
}

/**
 * 并入一条子 Agent 信封事件：按 parent_call_id 建或找 sub_agent section。
 *
 * @param state - 当前 store 状态，其 pendingSections 为查找基准。
 * @param env - 子 Agent 信封载荷，携带 agent/execution 标识与内层事件。
 * @returns 并入后的部分状态（pendingSections）；定位不到 section 时返回空对象表示无变化。
 */
function withSubAgentEvent(state: ChatState, env: SubAgentEnvelopePayload): Partial<ChatState> {
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
}

/**
 * 会话级状态复位：清空消息/流/卡片/错误并递增导航代次（通知流控制器作废旧连接）。
 * 保留会话侧栏列表状态（sessions/nextCursor/加载态），由 extra 按场景覆盖
 * （如 switchSession 的目标会话 id）。newSession / switchSession 共用同一基线。
 *
 * @param state - 当前 store 状态，用于在旧代次基础上递增导航代次。
 * @param extra - 场景覆盖项，叠加在复位基线之上（如目标会话 id、侧栏错误）。
 * @returns 复位后的部分状态。
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

/** 对话主投影 store 的完整类型：状态切片与其动作的交叉。 */
type ChatStore = ChatState & ChatActions

/** 对话主投影 store：消息列表、流式状态、待处理 section 与卡片提交态。 */
export const useChatStore = create<ChatStore>()(createChatStore)

/**
 * 构造对话主投影 store：把 SSE 事件折叠为消息与 section，并管理卡片提交与会话侧栏列表。
 * 独立成函数是为了让类型化的 `create<ChatStore>()` 能直接引用，避免在 create 调用处内联整块实现。
 *
 * @param set - zustand 的写入函数，提交部分状态或按前态计算新状态。
 * @param get - zustand 的读取函数，动作间读取最新状态（定稿、判定当前会话等）。
 * @returns 初始化完成的 store 对象，含全部状态与动作。
 */
function createChatStore(
  set: Parameters<StateCreator<ChatStore>>[0],
  get: Parameters<StateCreator<ChatStore>>[1]
): ChatStore {
  /** 追加一条用户消息（id 与时间戳在本地生成）。 */
  function addUserMessage(content: string): void {
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
  }

  /** 开始一轮流式：记下请求/会话 id 与起点时刻，清空上一轮的状态与错误。 */
  function startStreaming(requestId: string, sessionId: string): void {
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
  }

  /** 把在途 section 定稿为一条消息（续跑则合并进卡片消息），并清空 pendingSections。 */
  function finalizeStreamingText(terminalStatus?: 'cancelled'): void {
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
  }

  /** 追加一张待回答卡片。 */
  function setPendingCard(card: CardSectionData): void {
    // card 事件 → 作为 type="card" section 追加到在途消息
    set((state) => ({
      pendingSections: [...state.pendingSections, { type: 'card', card, timestamp: Date.now() }],
    }))
  }

  /** 把卡片标记为已回答，并写入用户提交的答案。 */
  function markCardAnswered(
    interactionId: string,
    answers: Record<string, QuestionCardAnswer>
  ): void {
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
  }

  /** 把卡片标记为已拒绝（answers 置空）。 */
  function markCardRefused(interactionId: string): void {
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
  }

  /** 进入卡片提交态（submitting），记录本次提交的答案与拒绝标记。 */
  function beginCardSubmission(
    interactionId: string,
    payload: {
      answers?: Record<string, QuestionCardAnswer> | undefined
      refused?: boolean | undefined
    }
  ): void {
    set({
      cardSubmission: {
        interactionId,
        state: 'submitting',
        answers: payload.answers,
        refused: payload.refused,
      },
    })
  }

  /** 标记卡片提交已被服务端受理。 */
  function acceptCardSubmission(): void {
    set((state) => ({
      cardSubmission:
        state.cardSubmission?.state === 'submitting'
          ? { ...state.cardSubmission, state: 'accepted' }
          : state.cardSubmission,
    }))
  }

  /** 提交收尾：按拒绝与否落定卡片，并清空提交态。 */
  function completeCardSubmission(): void {
    const submission = get().cardSubmission
    if (!submission) return

    if (submission.refused) {
      get().markCardRefused(submission.interactionId)
    } else {
      get().markCardAnswered(submission.interactionId, submission.answers ?? {})
    }
    set({ cardSubmission: null })
  }

  /** 提交失败：卡片转错误态，同时结束本轮流式与请求生命周期。 */
  function failCardSubmission(error: string): void {
    const submission = get().cardSubmission
    set({
      cardSubmission: submission ? { ...submission, state: 'error', error } : null,
      pendingSections: [],
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
    })
  }

  /** 确保在途 section 里已有一个思考块，没有则新建空思考块。 */
  function ensureThinkingBlock(): void {
    set(withThinkingBlock)
  }

  /** 工具开始：追加一条 running 的 tool section。 */
  function startToolCall(callId: string, toolName: string, params?: Record<string, unknown>): void {
    set((state) => ({
      pendingSections: applyToolStart(state.pendingSections, callId, toolName, params),
    }))
  }

  /** 工具成功落定，并把同 callId 的委派 section 收尾（剥掉续跑协议标记）。 */
  function completeToolCall(callId: string, result: string): void {
    set((state) => withCompletedToolCall(state, callId, result))
  }

  /** 工具失败落定，并把同 callId 的委派 section 收尾为失败。 */
  function failToolCall(callId: string, error: string): void {
    set((state) => withFailedToolCall(state, callId, error))
  }

  /** 并入一条子 Agent 信封事件：按 parent_call_id 建或找 sub_agent section。 */
  function appendSubAgentEvent(env: SubAgentEnvelopePayload): void {
    set((state) => withSubAgentEvent(state, env))
  }

  /** 把仍处于 running 的工具 section 收尾为中断态。 */
  function settleIncompleteTools(): void {
    set((state) => ({
      pendingSections: settleSectionsIncomplete(state.pendingSections),
    }))
  }

  /** 记录流式错误，并结束本轮请求生命周期。 */
  function setError(error: ErrorEvent): void {
    set({
      error,
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
    })
  }

  /** 停止流式：先定稿在途文本，再清空流式状态。 */
  function stopStreaming(terminalStatus?: 'cancelled'): void {
    get().finalizeStreamingText(terminalStatus)
    set({
      isStreaming: false,
      status: null,
      streamingStartedAt: 0,
      requestId: null,
    })
  }

  /** 拉取会话列表首屏。 */
  async function loadSessions(): Promise<void> {
    set({ sessionsLoading: true, sessionsError: null })
    try {
      const data = await fetchSessions()
      set({ sessions: data.sessions, nextCursor: data.next_cursor })
    } catch (e) {
      set({ sessionsError: extractErrorMessage(e) })
    } finally {
      set({ sessionsLoading: false })
    }
  }

  /** 以当前游标追加下一页会话列表（无游标或正在加载时跳过）。 */
  async function loadMoreSessions(): Promise<void> {
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
  }

  /** 切换会话：先清空并递增导航代次，再拉取目标会话（仍停留在目标会话时才落地）。 */
  async function switchSession(sessionId: string): Promise<void> {
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
  }

  return {
    ...initialState,

    addUserMessage,
    // 流式总耗时的真实锚点：前端发起本轮请求的时刻（含连接/鉴权等待），而非服务端首事件
    markSent: () => {
      set({ sentAt: Date.now() })
    },
    startStreaming,
    appendToken: (content) => {
      // pendingSections 是唯一数据源：token 只追加到最后一个 content section
      set((state) => ({ pendingSections: applyToken(state.pendingSections, content) }))
    },
    finalizeStreamingText,
    setPendingCard,
    markCardAnswered,
    markCardRefused,
    beginCardSubmission,
    acceptCardSubmission,
    completeCardSubmission,
    failCardSubmission,
    setStatus: (content) => {
      set({ status: content })
    },
    ensureThinkingBlock,
    appendReasonStep: (step, content) => {
      set((state) => ({ pendingSections: applyReasonStep(state.pendingSections, step, content) }))
    },
    startToolCall,
    completeToolCall,
    failToolCall,
    appendSubAgentEvent,
    settleIncompleteTools,
    setError,
    clearError: () => {
      set({ error: null })
    },
    stopStreaming,
    reset: () => {
      set((state) => ({ ...initialState, streamNavigationEpoch: state.streamNavigationEpoch + 1 }))
    },

    // ── 会话侧栏 actions ──────────────────────────────

    loadSessions,
    loadMoreSessions,
    switchSession,
    newSession: () => {
      set((state) => clearChatState(state))
    },
  }
}

/* store 一律不做热替换：React Fast Refresh 只重建"接受更新"的组件边界，没被重建的模块
   （如 useChatStream）会继续持有旧 store 实例，于是写入方与读取方各绑一份 state——
   表现就是实时投影不再跟随 SSE、流结束后同一轮出现两次。这里声明自接受并整页刷新，
   代价是开发期一次刷新，换来实例唯一（import.meta.hot 在生产构建中为 undefined）。 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
