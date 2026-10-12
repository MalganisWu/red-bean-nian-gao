import { useEffect, useMemo, useState } from 'react'
import { useScrollAnchor } from '@/hooks/useScrollAnchor'
import { ChatMessageItem } from './ChatMessageItem'
import { RoundNav, type RoundNavEntry } from '@/components/retroui/RoundNav'
import { MarkdownRenderer } from '@/components/retroui/MarkdownRenderer'
import { formatDurationMs } from '@/components/chat/processSections'
import { roundNavItems, type RoundNavItem } from '@/components/chat/roundNav'
import { useTaskStore } from '@/stores/task-store'
import type { CardSubmissionState, DisplayMessage, MessageSection } from '@/types/chat'
import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'
import type { ErrorEvent } from '@/types/events'
import { findCardMergeTarget, mergeContinuation } from '@/lib/card-merge'

interface ChatMessagesProps {
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingStartedAt: number
  /** 前端发起本轮请求的时刻（流式总耗时锚点，含连接/鉴权等待） */
  sentAt: number
  error: ErrorEvent | null
  onDismissError: () => void
  /** 失败重试（重发上一请求）；不传则错误横幅只提供关闭 */
  onRetry?: (() => void) | undefined
  pendingSections?: MessageSection[] | undefined
  onCardConfirm?:
    ((interactionId: string, answers: Record<string, QuestionCardAnswer>) => void) | undefined
  onCardRefuse?: ((interactionId: string) => void) | undefined
  cardSubmission?: CardSubmissionState | null | undefined
}

/** 消息区：渲染历史与流式中的消息，并承载底部跟随滚动与错误重试入口。 */
export function ChatMessages({
  messages,
  isStreaming,
  streamingStartedAt,
  sentAt,
  error,
  onDismissError,
  onRetry,
  pendingSections,
  onCardConfirm,
  onCardRefuse,
  cardSubmission,
}: ChatMessagesProps) {
  const scrollRef = useScrollAnchor(messages, pendingSections)
  const [currentNavId, setCurrentNavId] = useState<string | undefined>(undefined)
  const loadExecutionViewStates = useTaskStore((state) => state.loadExecutionViewStates)

  const scheduledExecutions = useMemo(() => messages.flatMap(scheduledExecutionsOf), [messages])
  const latestExecutionByTask = useMemo(
    () => latestExecutionsByTask(scheduledExecutions),
    [scheduledExecutions]
  )

  /** 排期变化时预取对应执行的视图状态（已看过/未看过）。 */
  function prefetchExecutionViewStates(): void {
    if (scheduledExecutions.length === 0) return
    void loadExecutionViewStates(scheduledExecutions.map((execution) => execution.executionID))
  }

  useEffect(prefetchExecutionViewStates, [loadExecutionViewStates, scheduledExecutions])

  // 发送后立即跑秒：无响应窗口（占位符）与思考块共用 sentAt 锚点，按整秒稳定刷新。
  const [now, setNow] = useState(() => Date.now())

  /** 流式期间每秒刷新锚点时钟；非流式不启动，停止时清理定时器。 */
  function tickSecondClock(): (() => void) | undefined {
    if (!isStreaming) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }

  useEffect(tickSecondClock, [isStreaming])

  const isEmpty = messages.length === 0 && !isStreaming

  // 续跑合并目标：answer 流期间把流式续跑就地渲染进目标卡片消息（避免先独立气泡再跳合并）
  const mergeIdx = findCardMergeTarget(messages)
  // 流式分界：空 reason（STATUS 打点但首条内容未到）不会产出可见折叠块——collapseToProcessFold
  // 对无步 reason 略过，MessageCard 此时渲染为空。这里把它判为「无响应」，让占位符继续按发送锚点跑秒，
  // 而不是被一个没法显示的折叠块顶掉。reason 有步 / 其余 section（content/card/tool_group/sub_agent）才算有内容。
  const hasStreaming =
    isStreaming &&
    (pendingSections?.some((s) => s.type !== 'reason' || s.items.length > 0) ?? false)

  // 轮次导航：user 消息派生横杠 + 悬停摘要（spec: round-nav-gutter §4/§6）
  const navItems = useMemo(() => roundNavItems(messages), [messages])
  const navEntries: RoundNavEntry[] = useMemo(
    () =>
      navItems.map((item, i) => ({
        id: item.messageId,
        preview: <RoundNavPreview item={item} ordinal={i + 1} />,
      })),
    [navItems]
  )

  // 点击横杠：平滑滚动到该轮（锚点在 ChatMessageItem 根元素）+ 1.2s 闪烁定位
  // 减动效偏好：瞬时跳转且不闪烁
  /** 点击横杠：记录当前轮并平滑滚动到该轮（锚点在 ChatMessageItem 根元素）+ 1.2s 闪烁定位。 */
  function jumpToRound(id: string): void {
    setCurrentNavId(id)
    const el = document.getElementById(id)
    if (!el) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    })
    if (reduceMotion) return
    el.classList.add('round-flash')
    window.setTimeout(() => el.classList.remove('round-flash'), 1200)
  }

  /** 渲染单条消息：answer 续跑期间把流式续跑 sections 并进目标卡片消息。 */
  function renderMessage(msg: DisplayMessage, i: number) {
    // answer 续跑：流式期间就把续跑 sections 并进目标卡片消息（卡片之后），
    // 与 finalizeStreamingText 落库合并共用 mergeContinuation，视觉连续、结果一致
    if (i === mergeIdx && isStreaming) {
      const merged = mergeContinuation(msg.sections ?? [], pendingSections ?? [])
      return (
        <ChatMessageItem
          key={msg.id}
          message={{ ...msg, sections: merged }}
          isStreaming
          onCardConfirm={onCardConfirm}
          onCardRefuse={onCardRefuse}
          cardSubmission={cardSubmission}
          taskExecutionIsLatest={
            msg.meta?.scheduled_task
              ? latestExecutionByTask.get(msg.meta.scheduled_task.task_id)?.executionID ===
                msg.meta.scheduled_task.execution_id
              : false
          }
        />
      )
    }
    return (
      <ChatMessageItem
        key={msg.id}
        message={msg}
        startsRound={msg.role === 'user' && i > 0}
        onCardConfirm={onCardConfirm}
        onCardRefuse={onCardRefuse}
        cardSubmission={cardSubmission}
        taskExecutionIsLatest={
          msg.meta?.scheduled_task
            ? latestExecutionByTask.get(msg.meta.scheduled_task.task_id)?.executionID ===
              msg.meta.scheduled_task.execution_id
            : false
        }
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左边沟：位于历史会话侧栏与正文之间，视线进入正文时自然经过；窄屏隐藏。 */}
      <div className="hidden w-14 shrink-0 sm:block">
        <RoundNav entries={navEntries} currentId={currentNavId} onSelect={jumpToRound} />
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 sm:py-10">
        <div className="mx-auto w-full max-w-[760px] space-y-7">
          {error && (
            <div
              role="alert"
              className="flex items-start justify-between gap-4 border-l-2 border-danger py-1.5 pl-3"
            >
              <div className="min-w-0">
                <p className="text-label tracking-label text-danger">请求失败</p>
                <p className="mt-1 break-all text-xs text-danger/80">{error.message}</p>
              </div>
              <div className="flex shrink-0 items-baseline gap-4">
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center text-xs text-danger underline underline-offset-2 transition-colors hover:text-foreground-body"
                  >
                    重试
                  </button>
                )}
                <button
                  onClick={onDismissError}
                  className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center text-xs text-foreground-faint underline-offset-2 transition-colors hover:text-foreground-body hover:underline"
                >
                  关闭
                </button>
              </div>
            </div>
          )}

          {isEmpty && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <p className="font-sans text-lg text-muted-foreground">说点什么，年糕听着。</p>
              <p className="mt-3 max-w-md text-xs leading-relaxed text-foreground-faint">
                可以直接提问；也可以说「明天早上 8 点提醒我……」，年糕会替你记着。
              </p>
            </div>
          )}
          {messages.map(renderMessage)}
          {/* Streaming assistant message — 无合并目标时才作为独立新消息流式渲染 */}
          {hasStreaming && mergeIdx < 0 && (
            <ChatMessageItem
              message={{
                id: 'streaming',
                role: 'assistant',
                sections: pendingSections,
                timestamp: streamingStartedAt,
                meta: sentAt > 0 ? { run_started_at: sentAt } : undefined,
              }}
              isStreaming
              cardSubmission={cardSubmission}
            />
          )}
          {/* 流式已开始但尚无可见内容：首个 STATUS 打点只生成空 reason（跑秒中），未产出折叠块。
            此刻保持占位符按发送锚点跑秒，避免「思考中」出现空白窗（续聊时也在视口内）。 */}
          {isStreaming && !hasStreaming && mergeIdx < 0 && (
            <p role="status" className="font-sans text-[13px] text-foreground-muted">
              正在处理…
              {sentAt > 0 && (
                <span className="not-italic tracking-normal text-foreground-faintest">
                  · {formatDurationMs(Math.max(0, now - sentAt))}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
      {/* 与左边沟等宽的透明占位，让正文继续与页头、输入框保持同一中轴。 */}
      <div aria-hidden="true" className="hidden w-14 shrink-0 sm:block" />
    </div>
  )
}

/** 排期锚点：任务 id / 执行 id / 计划时间。 */
interface ScheduledExecution {
  taskID: string
  executionID: string
  scheduledAt: number
}

/** 单条消息携带的排期锚点（无 scheduled_task 元信息则为空）。 */
function scheduledExecutionsOf(message: DisplayMessage): ScheduledExecution[] {
  const meta = message.meta?.scheduled_task
  if (!meta) return []
  return [{ taskID: meta.task_id, executionID: meta.execution_id, scheduledAt: meta.scheduled_at }]
}

/** 每个任务最近一次排期执行（按 scheduledAt 取最大）。 */
function latestExecutionsByTask(executions: ScheduledExecution[]): Map<string, ScheduledExecution> {
  const latest = new Map<string, ScheduledExecution>()
  for (const execution of executions) {
    const current = latest.get(execution.taskID)
    if (!current || execution.scheduledAt >= current.scheduledAt) {
      latest.set(execution.taskID, execution)
    }
  }
  return latest
}

// 摘要卡内容截断（粗略定位，多余省略）
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** 悬停摘要卡：用户原话 60 字 + 最终回答 110 字 + 回合元信息。 */
function RoundNavPreview({ item, ordinal }: { item: RoundNavItem; ordinal: number }) {
  const meta = [
    item.totalDuration,
    item.toolCount ? `${item.toolCount} 次工具调用` : null,
    `第 ${ordinal} 轮`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div>
      <div className="mb-0.5 text-xs text-foreground-muted">你</div>
      <div className="mb-2 text-[13px] leading-[1.6] text-foreground-body">
        {cut(item.question, 60)}
      </div>
      {item.answer && (
        <>
          <div className="mb-0.5 text-xs text-foreground-muted">年糕</div>
          <div className="border-t border-border pt-2 text-[12px] leading-[1.6] text-muted-foreground [&_p]:my-0">
            <MarkdownRenderer content={cut(item.answer, 110)} />
          </div>
        </>
      )}
      <div className="mt-2 text-xs text-foreground-faint">{meta}</div>
    </div>
  )
}
