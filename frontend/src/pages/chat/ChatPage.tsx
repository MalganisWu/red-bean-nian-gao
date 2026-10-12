import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useChatStream } from '@/hooks/useChatStream'
import { useChatStore } from '@/stores/chat-store'
import { useTrajectoryStore } from '@/stores/trajectory-store'
import { ChatMessages } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { useTaskStore } from '@/stores/task-store'
import { SessionSidebar } from '@/components/layout/SessionSidebar'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { SessionTaskListView } from './SessionTaskListView'
import { SessionTaskDetailView } from './SessionTaskDetailView'
import { SessionTrajectoryView } from './SessionTrajectoryView'
import { ExecutionResultView } from './ExecutionResultView'
import type { ChatMessage, CardSectionData } from '@/types/chat'
import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'
import type { ScheduledTaskDetailTab } from '@/components/retroui/scheduledTaskTypes'
import { trapTabFocus } from '@/lib/focus-trap'

// awaiting 的最大确认等待：超过即视为连接异常，强制复位（见 handleSend 下方兜底 effect）
const AWAITING_TIMEOUT_MS = 30_000

/** 对话主页面：串起输入区、流式状态与消息区，并持有「已发出、待 START 确认」的输入锁。 */
export function ChatPage() {
  const chat = useChatStream()
  const [input, setInput] = useState('')
  // 已发出但未被服务端确认（START 事件）前的等待窗：锁输入防双发，失败时草稿不丢。
  // 只用于锁输入；消息区跑秒/流式渲染必须由 store 的 isStreaming 真值驱动——
  // awaiting 若被顶进 isStreaming，连接半开时占位符会永久跑秒且无新调用。
  const [awaiting, setAwaiting] = useState(false)
  const lastDraftRef = useRef('')
  const loadSessions = useChatStore((s) => s.loadSessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessions = useChatStore((s) => s.sessions)
  const dismissError = useChatStore((s) => s.clearError)
  const prevStreamingRef = useRef(false)
  const activeSessionTitle =
    sessions.find((session) => session.id === activeSessionId)?.title || '新会话'

  // 待回答卡片：扫已加载 DisplayMessages 的 sections 里 type="card" 且 status=="pending"
  // （刷新/跨端恢复由此重建）
  const pendingCard = useMemo<CardSectionData | null>(() => {
    for (const m of chat.messages) {
      const card = (m.sections ?? []).find((s) => s.type === 'card' && s.card.status === 'pending')
      if (card && card.type === 'card') return card.card
    }
    return null
  }, [chat.messages])

  const answerCard = chat.answer

  const handleCardConfirm = useCallback(
    (interactionId: string, answers: Record<string, QuestionCardAnswer>) => {
      answerCard(interactionId, { answers })
    },
    [answerCard]
  )

  const handleCardRefuse = useCallback(
    (interactionId: string) => {
      answerCard(interactionId, { refused: true })
    },
    [answerCard]
  )

  type SessionView = 'chat' | 'task-list' | 'task-detail' | 'execution' | 'trajectory'
  const [sessionView, setSessionView] = useState<SessionView>('chat')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskTab, setSelectedTaskTab] = useState<ScheduledTaskDetailTab>('overview')
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)
  // 窄屏侧栏抽屉（≥md 常驻，见下方布局）
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null)

  // 抽屉焦点管理：开启移入、关闭归还触发钮；开启时锁 body 滚动、关闭恢复
  // （Escape 处理在遮罩 onKeyDown）
  useEffect(() => {
    if (sidebarOpen) {
      drawerRef.current?.focus()
      document.body.style.overflow = 'hidden'
    } else {
      drawerTriggerRef.current?.focus()
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [sidebarOpen])
  const sessionTasks = useTaskStore((s) => s.sessionTasks)
  const loadSessionTasks = useTaskStore((s) => s.loadSessionTasks)

  useEffect(() => {
    if (activeSessionId) {
      void loadSessionTasks(activeSessionId)
    }
  }, [activeSessionId, loadSessionTasks])

  // 流结束后刷新会话列表（更新侧栏标题/排序）
  useEffect(() => {
    if (prevStreamingRef.current && !chat.isStreaming) {
      void loadSessions()
    }
    prevStreamingRef.current = chat.isStreaming
  }, [chat.isStreaming, loadSessions])

  // 订阅 store 事件（非 effect 体内同步 setState）：
  // START 受理（isStreaming↑）→ 清草稿（期间用户新打的字不清）+ 解锁；失败（error↑）→ 解锁，草稿留在输入框
  useEffect(() => {
    return useChatStore.subscribe((s, prev) => {
      if (s.isStreaming && !prev.isStreaming) {
        setAwaiting(false)
        setInput((cur) => (cur === lastDraftRef.current ? '' : cur))
      }
      if (s.error && !prev.error) {
        setAwaiting(false)
      }
    })
  }, [])

  function handleSend() {
    if (!input.trim() || chat.isStreaming || awaiting || pendingCard) return
    // session_id 已让服务端能够加载完整历史；这里只发送当前一轮，不能重放旧消息。
    const messages: ChatMessage[] = [{ role: 'user', content: input.trim() }]
    lastDraftRef.current = input.trim()
    setAwaiting(true)
    /* 轨迹实时投影：用户消息发送即开轮（不等 SSE START），与 chat-store 同刻；
       带上已知会话 id，新会话则为 null（START 事件会补齐） */
    useTrajectoryStore.getState().beginUserTurn(input.trim(), activeSessionId)
    chat.send(messages, activeSessionId ?? undefined)
  }

  // awaiting 兜底：请求发出后若 START/error 均迟迟不到（连接半开等异常），
  // 30s 后强制复位等待窗，避免输入框与页面状态被永久锁死（fetch-sse 首事件看门狗
  // 会并行报错，这里保证 UI 状态绝不悬挂）。
  useEffect(() => {
    if (!awaiting) return
    const timer = window.setTimeout(() => {
      setAwaiting(false)
    }, AWAITING_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [awaiting])

  // 错误横幅「重试」：原样重发上一请求（useChatStream.retry 内部不重复追加用户消息）。
  // 草稿同样等 START 确认后才清（复用上面的订阅）
  function handleRetry() {
    if (chat.retry()) {
      dismissError()
      setAwaiting(true)
    }
  }

  function handleCancel() {
    void chat.cancel()
    // START 前取消：abort 静默（无 error/START 事件），订阅不会触发——这里显式解锁
    setAwaiting(false)
  }

  return (
    <div className="flex h-dvh bg-background">
      {/* 桌面：侧栏常驻；窄屏：模态抽屉（Escape/遮罩关闭，开启时焦点移入、关闭归还触发钮） */}
      <div className="hidden h-full md:flex">
        <SessionSidebar />
      </div>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSidebarOpen(false)
          }}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="会话目录"
            tabIndex={-1}
            onKeyDown={(e) => trapTabFocus(e, drawerRef.current)}
            className="relative h-full w-56 max-w-[80vw] border-r border-border"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="关闭会话目录"
              className="absolute right-1.5 top-1.5 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              ×
            </button>
            <SessionSidebar onNavigate={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}
      <div className="flex flex-1 flex-col min-w-0">
        {sessionView === 'chat' && (
          <>
            <div className="border-b border-border bg-background px-4 sm:px-6">
              <div className="mx-auto flex min-h-[60px] w-full max-w-[760px] items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    ref={drawerTriggerRef}
                    className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center bg-transparent text-xs text-foreground-muted transition-colors hover:text-foreground md:hidden"
                    onClick={() => setSidebarOpen(true)}
                    aria-expanded={sidebarOpen}
                    aria-label="打开会话目录"
                  >
                    目录
                  </button>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold leading-[1.35] text-foreground">
                      {activeSessionTitle}
                    </p>
                    <p className="mt-0.5 text-xs text-foreground-muted">
                      {chat.isStreaming || awaiting ? '正在进行' : '当前会话'}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ThemeToggle />
                  <span aria-hidden="true" className="h-3 w-px bg-border-strong" />
                  <button
                    className="min-h-11 cursor-pointer bg-transparent text-xs text-foreground-muted transition-colors hover:text-foreground"
                    onClick={() => setSessionView('trajectory')}
                  >
                    轨迹
                  </button>
                  <button
                    className="min-h-11 cursor-pointer bg-transparent text-xs text-foreground-muted transition-colors hover:text-foreground"
                    onClick={() => setSessionView('task-list')}
                  >
                    会话任务
                    {sessionTasks.length > 0 && ` · ${sessionTasks.length}`}
                  </button>
                </div>
              </div>
            </div>
            <ChatMessages
              messages={chat.messages}
              isStreaming={chat.isStreaming}
              streamingStartedAt={chat.streamingStartedAt}
              sentAt={chat.sentAt}
              error={chat.error}
              onDismissError={dismissError}
              onRetry={chat.canRetry() ? handleRetry : undefined}
              pendingSections={chat.pendingSections}
              onCardConfirm={handleCardConfirm}
              onCardRefuse={handleCardRefuse}
              cardSubmission={chat.cardSubmission}
            />
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              onCancel={handleCancel}
              isStreaming={chat.isStreaming || awaiting}
              pending={Boolean(pendingCard)}
            />
          </>
        )}

        {sessionView === 'task-list' && (
          <SessionTaskListView
            onBack={() => setSessionView('chat')}
            onSelectTask={(taskId: string) => {
              setSelectedTaskId(taskId)
              setSelectedTaskTab('overview')
              setSessionView('task-detail')
            }}
            onSelectExecution={(taskId: string, executionId: string) => {
              setSelectedTaskId(taskId)
              setSelectedExecutionId(executionId)
              setSelectedTaskTab('history')
              setSessionView('execution')
            }}
          />
        )}

        {sessionView === 'task-detail' && selectedTaskId && (
          <SessionTaskDetailView
            taskId={selectedTaskId}
            activeTab={selectedTaskTab}
            onBack={() => {
              setSelectedTaskId(null)
              setSessionView('task-list')
            }}
            onTabChange={setSelectedTaskTab}
            onViewExecution={(executionId: string) => {
              setSelectedExecutionId(executionId)
              setSessionView('execution')
            }}
          />
        )}

        {sessionView === 'trajectory' && (
          <SessionTrajectoryView onBack={() => setSessionView('chat')} />
        )}

        {sessionView === 'execution' && selectedTaskId && selectedExecutionId && (
          <ExecutionResultView
            taskId={selectedTaskId}
            executionId={selectedExecutionId}
            onBack={() => {
              setSelectedExecutionId(null)
              setSelectedTaskTab('history')
              setSessionView('task-detail')
            }}
          />
        )}
      </div>
    </div>
  )
}
