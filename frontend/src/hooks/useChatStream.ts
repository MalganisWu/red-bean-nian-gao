import { useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '@/stores/chat-store'
import { useTrajectoryStore } from '@/stores/trajectory-store'
import { connectSSE } from '@/services/sse/fetch-sse'
import { cancelChat } from '@/services/api/chat'
import {
  SSE_EVENT_TYPES,
  isStartEvent,
  isTokenEvent,
  isStatusEvent,
  isReasonEvent,
  isToolStartEvent,
  isToolResultEvent,
  isCardEvent,
  isErrorEvent,
  isSubAgentEnvelope,
  isCompactionEvent,
} from '@/types/events'
import type {
  AnswerRequest,
  CardSubmissionState,
  ChatMessage,
  ChatRequest,
  DisplayMessage,
  MessageSection,
} from '@/types/chat'
import type { ErrorEvent, ParsedSSEEvent } from '@/types/events'
import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'
import { API_ROUTES } from '@red-bean/api-contract'
import { DEFAULT_AGENT_ID } from '@/lib/constants'

interface AnswerPayload {
  answers?: Record<string, QuestionCardAnswer> | undefined
  refused?: boolean | undefined
}

/** 对话流 hook 的对外契约：实时状态 + 发送 / 取消 / 作答 / 重试四个动作。 */
export interface ChatStreamControls {
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingStartedAt: number
  sentAt: number
  requestId: string | null
  sessionId: string | null
  error: ErrorEvent | null
  pendingSections: MessageSection[]
  cardSubmission: CardSubmissionState | null
  send: (messages: ChatMessage[], sessionId?: string) => void
  cancel: () => Promise<void>
  answer: (interactionId: string, payload: AnswerPayload) => void
  retry: () => boolean
  canRetry: () => boolean
}

/** 消费一次对话流；同一批 SSE 事件分别喂给 chat-store（主展示）与 trajectory-store（轨迹投影）。 */
export function useChatStream(agentId = DEFAULT_AGENT_ID): ChatStreamControls {
  // 具名 selector 订阅流式相关状态：避免订阅整个 store，
  // 使 sessions 等无关状态变化（如 loadSessions）不触发本 hook 重渲染。
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingStartedAt = useChatStore((s) => s.streamingStartedAt)
  const sentAt = useChatStore((s) => s.sentAt)
  const requestId = useChatStore((s) => s.requestId)
  const storeSessionId = useChatStore((s) => s.sessionId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const error = useChatStore((s) => s.error)
  const pendingSections = useChatStore((s) => s.pendingSections)
  const cardSubmission = useChatStore((s) => s.cardSubmission)

  // Zustand actions 引用稳定，单独取出供回调使用
  const appendToken = useChatStore((s) => s.appendToken)
  const startStreaming = useChatStore((s) => s.startStreaming)
  const setStatus = useChatStore((s) => s.setStatus)
  const ensureThinkingBlock = useChatStore((s) => s.ensureThinkingBlock)
  const appendReasonStep = useChatStore((s) => s.appendReasonStep)
  const startToolCall = useChatStore((s) => s.startToolCall)
  const completeToolCall = useChatStore((s) => s.completeToolCall)
  const failToolCall = useChatStore((s) => s.failToolCall)
  const setPendingCard = useChatStore((s) => s.setPendingCard)
  const beginCardSubmission = useChatStore((s) => s.beginCardSubmission)
  const acceptCardSubmission = useChatStore((s) => s.acceptCardSubmission)
  const completeCardSubmission = useChatStore((s) => s.completeCardSubmission)
  const failCardSubmission = useChatStore((s) => s.failCardSubmission)
  const stopStreaming = useChatStore((s) => s.stopStreaming)
  const finalizeStreamingText = useChatStore((s) => s.finalizeStreamingText)
  const setError = useChatStore((s) => s.setError)
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const markSent = useChatStore((s) => s.markSent)
  const appendSubAgentEvent = useChatStore((s) => s.appendSubAgentEvent)
  const settleIncompleteTools = useChatStore((s) => s.settleIncompleteTools)

  const ctrlRef = useRef<AbortController | null>(null)
  // 每条连接分配递增序号。替换/取消旧连接后，它迟到的 onError/onClose 不得污染新流。
  const streamSequenceRef = useRef(0)
  // 最近一次请求（send 或 answer）：连接失败时供 retry 原样重发，不重复乐观追加用户消息。
  // started = 已收到 START：此后失败说明服务端可能已持久化本轮消息，retry 重放会造成
  // 会话历史重复用户气泡——故 retry 只对 pre-START（连接级）失败开放
  const lastRequestRef = useRef<{
    url?: string | undefined
    request: ChatRequest | AnswerRequest
    started: boolean
  } | null>(null)
  const tokenBufferRef = useRef('')
  const flushTimerRef = useRef<number | null>(null)

  const flushTokenBuffer = useCallback(
    /** 把缓冲中的增量 token 写入 store，并停止 flush 定时器。 */
    function flushPendingTokens(): void {
      if (tokenBufferRef.current) {
        appendToken(tokenBufferRef.current)
        tokenBufferRef.current = ''
      }
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current)
        flushTimerRef.current = null
      }
    },
    [appendToken]
  )

  const discardTokenBuffer = useCallback(
    /** 丢弃尚未 flush 的 token 缓冲，并停止 flush 定时器。 */
    function discardPendingTokens(): void {
      tokenBufferRef.current = ''
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current)
        flushTimerRef.current = null
      }
    },
    []
  )

  // 会话导航不是一次普通的流结束：必须先让所有旧回调失效，再 abort，且不能把旧 token
  // 缓冲 flush 到刚清空/刚切入的会话。Zustand subscribe 在 action set 时同步触发，避免
  // 等 React 重渲染/effect 后才处理而留下迟到 START/TOKEN/DONE 的竞态窗口。
  const invalidateActiveStream = useCallback(
    /** 让当前连接的迟到回调全部失效并中止连接，同时丢弃未 flush 的 token 缓冲。 */
    function invalidateStream(): void {
      streamSequenceRef.current += 1
      if (ctrlRef.current) {
        ctrlRef.current.abort()
        ctrlRef.current = null
      }
      discardTokenBuffer()
      lastRequestRef.current = null
    },
    [discardTokenBuffer]
  )

  useEffect(subscribeToStreamNavigation, [invalidateActiveStream])

  /** 订阅 store 的会话导航序号：切会话时同步失效当前流，不等 React 重渲染。 */
  function subscribeToStreamNavigation(): () => void {
    const unsubscribe = useChatStore.subscribe(
      function handleNavigationEpochChange(state, previous): void {
        if (state.streamNavigationEpoch !== previous.streamNavigationEpoch) {
          invalidateActiveStream()
        }
      }
    )
    return function unsubscribeAndInvalidateStream(): void {
      unsubscribe()
      invalidateActiveStream()
    }
  }

  const handleEvent = useCallback(
    /** 把一条 SSE 事件同时投影到 trajectory-store（轨迹）与 chat-store（主展示）。 */
    function applyStreamEvent(event: ParsedSSEEvent): void {
      /* 轨迹实时投影：同一批 SSE 事件的第二个投影（chat-store 为主投影）。
         轨迹 store 内部按需要自行校验，此处透传原始事件。 */
      useTrajectoryStore.getState().applyEvent(event)
      switch (event.eventType) {
        case SSE_EVENT_TYPES.HEARTBEAT:
          break
        case SSE_EVENT_TYPES.START: {
          // 运行时校验，字段缺失时安全跳过而非静默渲染异常
          if (!isStartEvent(event.data)) return
          if (lastRequestRef.current) lastRequestRef.current.started = true
          // 服务端已接受回答：立即把确认节点压缩为“问题 + 回答”，并让同一 Process
          // 进入 running；START 后答案已被消费，即使续跑失败也不能恢复 pending。
          acceptCardSubmission()
          startStreaming(event.data.request_id, event.data.session_id)
          // 启动 token 批量 flush 定时器（100ms 节流写入 store）
          flushTimerRef.current = window.setInterval(function pushBufferedToken(): void {
            if (tokenBufferRef.current) {
              appendToken(tokenBufferRef.current)
              tokenBufferRef.current = ''
            }
          }, 100)
          break
        }
        case SSE_EVENT_TYPES.TOKEN: {
          if (!isTokenEvent(event.data)) return
          tokenBufferRef.current += event.data.content
          break
        }
        case SSE_EVENT_TYPES.STATUS: {
          if (!isStatusEvent(event.data)) return
          setStatus(event.data.content)
          // 确保思考卡片立即渲染，不等待内容
          ensureThinkingBlock()
          break
        }
        case SSE_EVENT_TYPES.REASON: {
          if (!isReasonEvent(event.data)) return
          appendReasonStep(event.data.step, event.data.content)
          break
        }
        case SSE_EVENT_TYPES.TOOL_START: {
          if (!isToolStartEvent(event.data)) return
          startToolCall(event.data.call_id, event.data.tool_name, event.data.params ?? undefined)
          break
        }
        case SSE_EVENT_TYPES.TOOL_RESULT: {
          if (!isToolResultEvent(event.data)) return
          // error 非空 = 工具失败（后端 core.ToolResultEvent.Error 一等信号），
          // 不再把 errJSON 当成功结果展示
          if (event.data.error) {
            failToolCall(event.data.call_id, event.data.error)
          } else {
            completeToolCall(event.data.call_id, event.data.content)
          }
          break
        }
        case SSE_EVENT_TYPES.CARD: {
          if (!isCardEvent(event.data)) return
          // 实时通道：卡片作为 type="card" section 挂到在途消息
          setPendingCard({
            interaction_id: event.data.interaction_id,
            status: event.data.status,
            questions: event.data.questions,
            answers: null,
          })
          break
        }
        case SSE_EVENT_TYPES.AGENT_EVENT: {
          // 子 Agent 委派：信封含来源标记 + 内层主 Agent 同构事件，store 按 parent_call_id 归并
          if (!isSubAgentEnvelope(event.data)) return
          appendSubAgentEvent(event.data)
          break
        }
        case SSE_EVENT_TYPES.COMPACTION: {
          // 压缩是 Runtime 诊断事件，不创建可见步骤；仍校验 payload，防止协议漂移静默进入前端。
          if (!isCompactionEvent(event.data)) return
          break
        }
        case SSE_EVENT_TYPES.DONE: {
          flushTokenBuffer()
          settleIncompleteTools()
          /* 轨迹投影同构收尾：仍 running 的行收成 incomplete，否则终态页面
             会永久显示「正在执行」（interrupting 工具与被打断的工具都不会有 tool_result） */
          useTrajectoryStore.getState().settleIncomplete()
          // 卡片仍为 pending 时先把续跑 sections 合回原消息，随后再落 answered/refused。
          stopStreaming()
          completeCardSubmission()
          break
        }
        case SSE_EVENT_TYPES.ERROR: {
          flushTokenBuffer()
          if (!isErrorEvent(event.data)) return
          const submission = useChatStore.getState().cardSubmission
          if (submission?.state === 'submitting') {
            // START 前失败：后端尚未接受答案，卡片保持 pending，可原地重试。
            failCardSubmission(event.data.message)
            break
          }
          // START 后答案已被后端消费：续跑失败也必须保留 answered/refused，不能伪装成可重答。
          settleIncompleteTools()
          /* 轨迹投影同构收尾：仍 running 的行收成 incomplete，否则终态页面
             会永久显示「正在执行」（interrupting 工具与被打断的工具都不会有 tool_result） */
          useTrajectoryStore.getState().settleIncomplete()
          finalizeStreamingText('cancelled')
          if (submission?.state === 'accepted') completeCardSubmission()
          setError(event.data)
          break
        }
      }
    },
    // actions 稳定，仅 flushTokenBuffer 依赖变化
    [
      appendToken,
      acceptCardSubmission,
      startStreaming,
      setStatus,
      ensureThinkingBlock,
      appendReasonStep,
      startToolCall,
      completeToolCall,
      failToolCall,
      setPendingCard,
      appendSubAgentEvent,
      settleIncompleteTools,
      completeCardSubmission,
      failCardSubmission,
      stopStreaming,
      finalizeStreamingText,
      setError,
      flushTokenBuffer,
    ]
  )

  // 发起一条 SSE 流（send / answer / retry 共用同一组回调与 onError 处理）
  const openStream = useCallback(
    /** 发起一条 SSE 流，并把这次请求登记为「最近一次请求」供 retry 原样重发。 */
    function startStream(url: string | undefined, request: ChatRequest | AnswerRequest): void {
      lastRequestRef.current = { url, request, started: false }
      const streamSequence = ++streamSequenceRef.current
      // 取消既有连接（若存在）
      if (ctrlRef.current) ctrlRef.current.abort()

      ctrlRef.current = connectSSE({
        url,
        request,
        onEvent: function handleStreamEvent(event): void {
          if (streamSequence !== streamSequenceRef.current) return
          handleEvent(event)
        },
        onError: function handleStreamError(err): void {
          if (streamSequence !== streamSequenceRef.current) return
          flushTokenBuffer()
          const submission = useChatStore.getState().cardSubmission
          if (submission?.state === 'submitting') {
            failCardSubmission(err.message)
            return
          }
          settleIncompleteTools()
          /* 轨迹投影同构收尾：仍 running 的行收成 incomplete，否则终态页面
             会永久显示「正在执行」（interrupting 工具与被打断的工具都不会有 tool_result） */
          useTrajectoryStore.getState().settleIncomplete()
          finalizeStreamingText('cancelled')
          if (submission?.state === 'accepted') completeCardSubmission()
          setError({ code: 500, message: err.message })
        },
        onClose: function handleStreamClose(): void {
          if (streamSequence !== streamSequenceRef.current) return
          flushTokenBuffer()
          const state = useChatStore.getState()
          if (state.cardSubmission?.state === 'submitting') {
            failCardSubmission('连接已中断，请重新确认。')
            return
          }
          if (state.isStreaming) {
            settleIncompleteTools()
            /* 轨迹投影同构收尾：仍 running 的行收成 incomplete，否则终态页面
               会永久显示「正在执行」（interrupting 工具与被打断的工具都不会有 tool_result） */
            useTrajectoryStore.getState().settleIncomplete()
            finalizeStreamingText('cancelled')
            if (state.cardSubmission?.state === 'accepted') completeCardSubmission()
            setError({ code: 500, message: '连接已中断，请重试。' })
          } else if (lastRequestRef.current && !lastRequestRef.current.started && !state.error) {
            setError({ code: 500, message: '连接已中断，请重试。' })
          }
        },
      })
    },
    [
      handleEvent,
      flushTokenBuffer,
      failCardSubmission,
      settleIncompleteTools,
      finalizeStreamingText,
      completeCardSubmission,
      setError,
    ]
  )

  const send = useCallback(
    /** 发送一轮用户消息：定位会话、乐观追加用户气泡，随后发起 SSE 流。 */
    function sendMessage(messages: ChatMessage[], sessionId?: string): void {
      // 已有会话的历史由服务端按 session_id 加载，请求只携带本轮 user 消息。
      // 这里兼容仍传入完整历史的旧调用方，避免历史被再次追加进持久化上下文。
      const lastUserMsg = messages.findLast((message) => message.role === 'user')
      const effectiveSessionId = sessionId ?? storeSessionId ?? undefined
      if (effectiveSessionId && !lastUserMsg) return
      if (lastUserMsg) addUserMessage(lastUserMsg.content)

      const requestMessages = effectiveSessionId && lastUserMsg ? [lastUserMsg] : messages

      const request: ChatRequest = {
        messages: requestMessages,
        session_id: effectiveSessionId,
        agent_id: agentId,
      }

      markSent()
      openStream(undefined, request)
    },
    [agentId, storeSessionId, addUserMessage, markSent, openStream]
  )

  // 失败重试：原样重发最近一次请求（send 或 answer）。
  // 用户消息在首次 send 时已乐观追加，重试不得重复追加；
  // 已收到 START 的流（服务端可能已持久化）不允许重放，防止会话历史重复。
  const canRetry = useCallback(
    (): boolean => Boolean(lastRequestRef.current) && !lastRequestRef.current?.started,
    []
  )

  const retry = useCallback(
    /** 原样重发最近一次请求；已收到 START 的流不允许重放。 */
    function retryLastRequest(): boolean {
      const last = lastRequestRef.current
      if (!last || last.started) return false
      if (last.url === API_ROUTES.CHAT_ANSWER.path && cardSubmission) {
        beginCardSubmission(cardSubmission.interactionId, {
          answers: cardSubmission.answers,
          refused: cardSubmission.refused,
        })
      }
      markSent()
      openStream(last.url, last.request)
      return true
    },
    [cardSubmission, beginCardSubmission, markSent, openStream]
  )

  const cancel = useCallback(
    /** 取消当前流：先失效连接回调再 abort，随后通知服务端取消。 */
    async function cancelActiveStream(): Promise<void> {
      // 先失效当前连接回调，再 abort；避免 abort 触发的迟到 onClose 被当成异常断线。
      const cancelSequence = ++streamSequenceRef.current
      if (ctrlRef.current) {
        ctrlRef.current.abort()
        ctrlRef.current = null
      }
      flushTokenBuffer()
      if (cardSubmission?.state === 'submitting') {
        failCardSubmission('已停止，可重新确认。')
      } else {
        settleIncompleteTools()
        /* 轨迹投影同构收尾：仍 running 的行收成 incomplete，否则终态页面
         会永久显示「正在执行」（interrupting 工具与被打断的工具都不会有 tool_result） */
        useTrajectoryStore.getState().settleIncomplete()
        stopStreaming('cancelled')
        if (cardSubmission?.state === 'accepted') completeCardSubmission()
      }
      if (requestId) {
        try {
          await cancelChat({ request_id: requestId })
        } catch (err) {
          // 本地流已经安全停止。只有期间未开启新流/切换会话时才展示取消 API 错误，
          // 避免迟到的失败反过来污染用户刚开始的新一轮。
          if (cancelSequence !== streamSequenceRef.current) return
          const message = err instanceof Error ? err.message : '未知错误'
          setError({
            code: 500,
            message: `已停止本地生成，但通知服务端取消失败：${message}`,
          })
        }
      }
    },
    [
      requestId,
      cardSubmission,
      failCardSubmission,
      flushTokenBuffer,
      settleIncompleteTools,
      stopStreaming,
      completeCardSubmission,
      setError,
    ]
  )

  // answer：提交询问卡片答案/拒绝 → POST /answer → 续跑 SSE（与 send 同一条 handleEvent）
  const answer = useCallback(
    /** 提交询问卡片的答案/拒绝，随后用同一条 handleEvent 续跑 SSE。 */
    function submitAnswer(interactionId: string, payload: AnswerPayload): void {
      // storeSessionId 只在活流（startStreaming）时设置；刷新恢复/侧栏切会话时
      // sessionId 为 null，此时用 activeSessionId 定位会话
      const sid = storeSessionId ?? activeSessionId
      if (!sid) return
      // 卡片在 DONE 前保持 pending：提交中锁定，失败原地恢复并保留选择。
      beginCardSubmission(interactionId, payload)

      const request: AnswerRequest = {
        session_id: sid,
        interaction_id: interactionId,
        agent_id: agentId,
        answers: payload.answers,
        refused: payload.refused,
      }

      markSent()
      openStream(API_ROUTES.CHAT_ANSWER.path, request)
    },
    [agentId, storeSessionId, activeSessionId, beginCardSubmission, markSent, openStream]
  )

  return {
    messages,
    isStreaming,
    streamingStartedAt,
    sentAt,
    requestId,
    sessionId: storeSessionId,
    error,
    pendingSections,
    cardSubmission,
    send,
    cancel,
    answer,
    retry,
    canRetry,
  }
}
