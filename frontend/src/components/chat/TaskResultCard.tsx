import { useEffect, useRef, useState } from 'react'
import { CalendarClock, ChevronDown, ChevronUp } from 'lucide-react'

import { formatDateTime } from '@/lib/datetime'
import { cn } from '@/lib/utils'
import { fetchTask } from '@/services/api/task'
import { useTaskStore } from '@/stores/task-store'
import type { DisplayMessage, MessageSection } from '@/types/chat'
import type { Task } from '@/types/task'

import { MessageCard } from './MessageCard'
import { getTaskResultDefaultCollapsed } from './taskResultState'

/** 定时任务结果卡片属性：待渲染的展示消息，以及它是否为该任务的最新一次运行。 */
interface TaskResultCardProps {
  /** 待渲染的展示消息；其 meta.scheduled_task 提供该轮任务的运行元信息。 */
  message: DisplayMessage
  /** 同一任务在当前上下文中的最新一次运行默认保持展开。 */
  isLatest?: boolean | undefined
}

/**
 * 生成任务卡片的「执行规则」文案：周期任务展示 cron，单次任务展示触发时间。
 *
 * @param task - 源任务；读取 `ScheduleType`、`CronExpr` 与 `RunAt`。
 * @returns 单行执行规则文案；cron 为空时回落为「周期执行」，时间缺失时回落为「单次执行」。
 */
function taskRule(task: Task): string {
  if (task.ScheduleType === 'recurring') return task.CronExpr || '周期执行'
  return formatDateTime(task.RunAt, '单次执行')
}

/**
 * 生成任务卡片的「下次执行」文案：已结束的单次任务直接标记终态，其余展示下次触发时间。
 *
 * @param task - 源任务；读取 `ScheduleType`、`IsActive` 与 `NextRunAt`。
 * @returns 单行下次执行文案；单次且已停用返回「已结束」，无下次触发时间则回落为「待调度」。
 */
function nextRunLabel(task: Task): string {
  if (task.ScheduleType === 'once' && !task.IsActive) return '已结束'
  return formatDateTime(task.NextRunAt, '待调度')
}

/**
 * 定时任务事件外壳：任务信息与执行结果独立折叠，正文继续复用普通 MessageCard。
 *
 * @param props - 组件属性；字段语义见 `TaskResultCardProps`。
 */
export function TaskResultCard(props: TaskResultCardProps) {
  const { message, isLatest = false } = props
  const meta = message.meta?.scheduled_task
  const executionID = meta?.execution_id ?? ''
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [taskDetails, setTaskDetails] = useState<Task | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  // 服务端状态返回前不渲染结果，避免已读历史内容先展开、随后突然收起。
  const [resultCollapsed, setResultCollapsed] = useState<boolean | null>(initialResultCollapsed)

  // 结果区的初始折叠态：服务端状态尚未返回时保持 null，等状态就绪后再定。
  function initialResultCollapsed(): boolean | null {
    if (!executionID) return false
    const state = useTaskStore.getState()
    if (!state.executionViewStatesLoaded[executionID]) return null
    return getTaskResultDefaultCollapsed({
      status: meta?.status ?? 'completed',
      isLatest,
      viewState: state.executionViewStates[executionID],
    })
  }
  const [collapseSaving, setCollapseSaving] = useState(false)
  const [collapseError, setCollapseError] = useState<string | null>(null)
  const readTargetRef = useRef<HTMLElement>(null)
  const collapseInitialized = useRef(resultCollapsed !== null)
  const seenAttempts = useRef(0)

  const viewState = useTaskStore((state) => state.executionViewStates[executionID])
  const viewStateLoaded = useTaskStore(
    (state) => state.executionViewStatesLoaded[executionID] ?? false
  )
  const markExecutionSeen = useTaskStore((state) => state.markExecutionSeen)
  const setExecutionCollapsed = useTaskStore((state) => state.setExecutionCollapsed)

  useEffect(restoreServerCollapsedState, [isLatest, meta, viewState, viewStateLoaded])

  // 服务端状态就绪后用它覆盖一次折叠态；之后只由用户操作驱动，不再跟随服务端。
  function restoreServerCollapsedState(): void {
    if (!meta || !viewStateLoaded || collapseInitialized.current) return
    setResultCollapsed(
      getTaskResultDefaultCollapsed({
        status: meta.status,
        isLatest,
        viewState,
      })
    )
    collapseInitialized.current = true
  }

  useEffect(markResultSeenWhenVisible, [
    executionID,
    markExecutionSeen,
    meta,
    viewState?.seen_at,
    viewStateLoaded,
  ])

  // 结果区滚入视口时把本次执行标记为已读；标记失败最多重试 3 次。
  function markResultSeenWhenVisible(): (() => void) | undefined {
    if (
      !meta ||
      !viewStateLoaded ||
      viewState?.seen_at ||
      seenAttempts.current >= 3 ||
      !readTargetRef.current
    )
      return undefined
    // 上面已排除 undefined；取成本地常量，供下方嵌套函数按已收窄的类型使用。
    const taskId = meta.task_id
    let visibilityTimer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let visible = false

    // 清掉两个可能待触发的计时器。
    function clearTimers(): void {
      if (visibilityTimer) clearTimeout(visibilityTimer)
      if (retryTimer) clearTimeout(retryTimer)
      visibilityTimer = undefined
      retryTimer = undefined
    }

    // 标记本次执行已读；失败且仍可见时按已尝试次数递增退避重试。
    async function attemptMarkSeen(): Promise<void> {
      visibilityTimer = undefined
      retryTimer = undefined
      if (disposed || !visible || useTaskStore.getState().executionViewStates[executionID]?.seen_at)
        return
      seenAttempts.current += 1
      const saved = await markExecutionSeen(taskId, executionID)
      if (!saved && !disposed && visible && seenAttempts.current < 3) {
        retryTimer = setTimeout(() => void attemptMarkSeen(), 1000 * seenAttempts.current)
      }
    }

    // 安排一次首次标记（800ms 后）；已有待触发计时器时不重复安排。
    function scheduleInitialAttempt(): void {
      if (!visibilityTimer && !retryTimer) {
        visibilityTimer = setTimeout(() => void attemptMarkSeen(), 800)
      }
    }

    // 卸载清理：停止计时器，并让在途的标记回调失效。
    function dispose(): void {
      disposed = true
      clearTimers()
    }

    if (typeof IntersectionObserver === 'undefined') {
      visible = true
      scheduleInitialAttempt()
      return dispose
    }

    // 可见性变化：进入 60% 视口才安排标记，移出视口则撤掉计时器。
    function handleIntersection(entries: IntersectionObserverEntry[]): void {
      const entry = entries[0]
      if (!entry) return
      visible = entry.isIntersecting && entry.intersectionRatio >= 0.6
      if (visible) {
        scheduleInitialAttempt()
      } else {
        clearTimers()
      }
    }

    const observer = new IntersectionObserver(handleIntersection, { threshold: [0.6] })
    // 只观察固定高度的任务头。完整 section 可能高于 1.67 个视口，永远达不到 60%。
    observer.observe(readTargetRef.current)
    return function disconnectObserver(): void {
      disposed = true
      observer.disconnect()
      clearTimers()
    }
  }

  if (!meta) return null

  const taskMeta = meta
  const isFailed = taskMeta.status === 'failed'
  const executedAt = taskMeta.completed_at ?? taskMeta.scheduled_at
  let renderedSections = message.sections
  const hasProcessDetail = renderedSections?.some((section) => section.type !== 'content') ?? false
  if (isFailed && !hasProcessDetail) {
    const finalSections: MessageSection[] =
      renderedSections && renderedSections.length > 0
        ? renderedSections
        : message.content
          ? [
              {
                type: 'content',
                content: message.content,
                timestamp: message.timestamp,
              },
            ]
          : []
    renderedSections = [
      {
        type: 'reason',
        items: [{ itemType: 'step', content: '任务未能完成，未提供更多执行过程。' }],
        timestamp: executedAt,
      },
      ...finalSections,
    ]
  }

  async function loadTaskDetails(): Promise<void> {
    if (taskDetails || detailsLoading) return
    setDetailsLoading(true)
    setDetailsError(null)
    try {
      setTaskDetails(await fetchTask(taskMeta.task_id))
    } catch {
      setDetailsError('任务信息加载失败，请重试')
    } finally {
      setDetailsLoading(false)
    }
  }

  function toggleTaskDetails(): void {
    const nextExpanded = !detailsExpanded
    setDetailsExpanded(nextExpanded)
    if (nextExpanded) void loadTaskDetails()
  }

  async function toggleResult(): Promise<void> {
    if (collapseSaving || resultCollapsed === null) return
    const nextCollapsed = !resultCollapsed
    setResultCollapsed(nextCollapsed)
    setCollapseError(null)
    setCollapseSaving(true)
    const saved = await setExecutionCollapsed(
      taskMeta.task_id,
      taskMeta.execution_id,
      nextCollapsed
    )
    setCollapseSaving(false)
    if (!saved) {
      setResultCollapsed(!nextCollapsed)
      setCollapseError('折叠状态未保存，请重试')
    }
  }

  return (
    <section
      className="w-full max-w-[760px]"
      aria-label={`${taskMeta.task_name}，${isFailed ? '失败' : '已完成'}，${formatDateTime(new Date(executedAt).toISOString())}`}
    >
      <header ref={readTargetRef} className="border-y border-border py-3.5 transition-colors">
        <div className="flex min-w-0 items-center gap-3.5 max-[760px]:flex-wrap max-[760px]:items-start max-[760px]:gap-[11px]">
          <button
            type="button"
            aria-expanded={detailsExpanded}
            aria-controls={`task-details-${meta.execution_id}`}
            onClick={toggleTaskDetails}
            className="group grid min-w-0 flex-1 cursor-pointer grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 bg-transparent p-0 text-left text-inherit focus-visible:rounded-md max-[760px]:w-full max-[760px]:basis-full max-[760px]:grid-cols-[31px_minmax(0,1fr)_auto] max-[760px]:gap-2.5"
          >
            <span
              className="grid h-[34px] w-[34px] place-items-center rounded-lg border border-border-strong text-brand-indicator max-[760px]:h-[31px] max-[760px]:w-[31px]"
              aria-hidden="true"
            >
              <CalendarClock className="h-[15px] w-[15px]" strokeWidth={1.5} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-sans text-[10.5px] font-medium leading-[1.4] text-brand-text">
                <span className="h-1 w-1 rounded-full bg-brand-indicator" aria-hidden="true" />
                定时任务 · 自动执行
              </span>
              <strong
                id={`task-title-${meta.execution_id}`}
                className="mt-[3px] block truncate font-sans text-[15px] font-semibold tracking-[-0.01em] text-foreground transition-colors group-hover:text-primary-hover"
              >
                {meta.task_name}
              </strong>
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap font-sans text-[11px] text-foreground-muted max-[760px]:flex-col max-[760px]:items-end max-[760px]:gap-0.5 max-[760px]:text-[10.5px]">
              <span
                className={cn(
                  'inline-flex items-center gap-[5px] font-medium',
                  isFailed ? 'text-danger' : 'text-success'
                )}
              >
                <span
                  className={cn(
                    'h-[5px] w-[5px] rounded-full',
                    isFailed ? 'bg-danger-indicator' : 'bg-success-indicator'
                  )}
                  aria-hidden="true"
                />
                {isFailed ? '失败' : '已完成'}
              </span>
              {executedAt > 0 && (
                <time dateTime={new Date(executedAt).toISOString()}>
                  {formatDateTime(new Date(executedAt).toISOString())}
                </time>
              )}
              <ChevronDown
                aria-hidden="true"
                className={cn('h-3 w-3 transition-transform', detailsExpanded && 'rotate-180')}
                strokeWidth={1.4}
              />
            </span>
          </button>

          <button
            type="button"
            aria-expanded={resultCollapsed === null ? undefined : !resultCollapsed}
            aria-controls={`task-result-${meta.execution_id}`}
            disabled={collapseSaving || resultCollapsed === null}
            onClick={() => void toggleResult()}
            className={cn(
              'inline-flex shrink-0 cursor-pointer items-center gap-[5px] bg-transparent py-1.5 font-sans text-[11px] text-foreground-muted transition-colors hover:text-primary-hover disabled:cursor-wait disabled:opacity-55 max-[760px]:ml-[41px]',
              resultCollapsed === null && 'invisible'
            )}
          >
            {resultCollapsed ? '展开结果' : '收起结果'}
            {resultCollapsed ? (
              <ChevronDown aria-hidden="true" className="h-3 w-3" strokeWidth={1.4} />
            ) : (
              <ChevronUp aria-hidden="true" className="h-3 w-3" strokeWidth={1.4} />
            )}
          </button>
        </div>

        {detailsExpanded && (
          <div
            id={`task-details-${meta.execution_id}`}
            className="ml-[46px] mt-[15px] grid grid-cols-3 gap-[18px] border-t border-border pt-3.5 max-[760px]:ml-[41px] max-[760px]:grid-cols-1 max-[760px]:gap-2.5"
          >
            {detailsLoading ? (
              <p role="status" className="col-span-full text-xs text-foreground-muted">
                正在加载任务信息…
              </p>
            ) : detailsError ? (
              <button
                type="button"
                className="col-span-full min-h-11 w-fit bg-transparent px-0 text-left text-xs text-danger underline underline-offset-2"
                onClick={() => void loadTaskDetails()}
              >
                {detailsError}
              </button>
            ) : taskDetails ? (
              <>
                <div>
                  <span className="block text-[10.5px] text-foreground-muted">执行规则</span>
                  <strong className="mt-1 block font-sans text-xs font-medium leading-normal text-foreground-body">
                    {taskRule(taskDetails)}
                  </strong>
                </div>
                <div>
                  <span className="block text-[10.5px] text-foreground-muted">本次触发</span>
                  <strong className="mt-1 block font-sans text-xs font-medium leading-normal text-foreground-body">
                    计划自动触发
                  </strong>
                </div>
                <div>
                  <span className="block text-[10.5px] text-foreground-muted">下次执行</span>
                  <strong className="mt-1 block font-sans text-xs font-medium leading-normal text-foreground-body">
                    {nextRunLabel(taskDetails)}
                  </strong>
                </div>
              </>
            ) : null}
          </div>
        )}
      </header>

      {resultCollapsed === false ? (
        <div id={`task-result-${meta.execution_id}`} className="pt-[22px]">
          <MessageCard
            content={message.content}
            sections={renderedSections}
            meta={message.meta}
            terminalStatus={isFailed ? 'failed' : 'completed'}
          />
          <div className="mt-3 flex justify-end">
            <span className="text-[10.5px] text-foreground-muted">结果已写入任务运行记录</span>
          </div>
        </div>
      ) : resultCollapsed === true ? (
        <p
          id={`task-result-${meta.execution_id}`}
          aria-live="polite"
          className="flex items-center gap-[7px] pt-3 font-sans text-[11px] text-foreground-muted before:h-px before:w-4 before:bg-border-strong before:content-['']"
        >
          执行结果已收起，点击“展开结果”恢复
        </p>
      ) : (
        <p role="status" className="sr-only">
          正在读取执行结果显示状态…
        </p>
      )}
      {collapseError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {collapseError}
        </p>
      )}
    </section>
  )
}
