import { useEffect } from 'react'

import { MessageCard } from '@/components/chat/MessageCard'
import { normalizePersistedSections } from '@/components/chat/processSections'
import { formatExecutionDuration, taskTitle } from '@/components/task/scheduledTaskPresentation'
import { ScheduledExecutionHeader } from '@/components/retroui/ScheduledExecutionHeader'
import { formatDateTime, formatShortDateTime } from '@/lib/datetime'
import { useTaskStore } from '@/stores/task-store'
import type { MessageSection } from '@/types/chat'

interface ExecutionResultViewProps {
  taskId: string
  executionId: string
  onBack: () => void
}

function timeOnly(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** 独立单次执行页：任务事件外壳留在聊天流，这里只展示运行元信息、Process 与 Final。 */
export function ExecutionResultView({ taskId, executionId, onBack }: ExecutionResultViewProps) {
  const activeExecution = useTaskStore((state) => state.activeExecution)
  const activeExecutionLoading = useTaskStore((state) => state.activeExecutionLoading)
  const currentTask = useTaskStore((state) => state.currentTask)
  const currentTaskLoading = useTaskStore((state) => state.currentTaskLoading)
  const executionViewState = useTaskStore((state) => state.executionViewStates[executionId])
  const executionViewStateLoaded = useTaskStore(
    (state) => state.executionViewStatesLoaded[executionId] ?? false
  )
  const error = useTaskStore((state) => state.error)
  const loadTaskDetail = useTaskStore((state) => state.loadTaskDetail)
  const loadExecutionDetail = useTaskStore((state) => state.loadExecutionDetail)
  const loadExecutionViewStates = useTaskStore((state) => state.loadExecutionViewStates)
  const markExecutionSeen = useTaskStore((state) => state.markExecutionSeen)

  useEffect(() => {
    void loadTaskDetail(taskId)
    void loadExecutionDetail(taskId, executionId)
  }, [executionId, loadExecutionDetail, loadTaskDetail, taskId])

  useEffect(() => {
    if (activeExecution?.TaskID !== taskId || activeExecution.ExecutionID !== executionId) return
    void loadExecutionViewStates([executionId])
  }, [activeExecution, executionId, loadExecutionViewStates, taskId])

  useEffect(() => {
    if (!executionViewStateLoaded || executionViewState?.seen_at) return
    const timer = window.setTimeout(() => {
      void markExecutionSeen(taskId, executionId)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [
    executionId,
    executionViewState?.seen_at,
    executionViewStateLoaded,
    markExecutionSeen,
    taskId,
  ])

  const executionMatches =
    activeExecution?.TaskID === taskId && activeExecution.ExecutionID === executionId
  const taskMatches = currentTask?.TaskID === taskId

  if (activeExecutionLoading || currentTaskLoading || !executionMatches || !taskMatches) {
    return (
      <div className="flex h-full items-center justify-center px-5">
        {error && !activeExecutionLoading && !currentTaskLoading ? (
          <div className="text-center">
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
            <button
              type="button"
              className="mt-3 min-h-11 cursor-pointer bg-transparent px-0 text-xs text-primary underline underline-offset-2 sm:min-h-0"
              onClick={() => {
                void loadTaskDetail(taskId)
                void loadExecutionDetail(taskId, executionId)
              }}
            >
              重试
            </button>
          </div>
        ) : (
          <p role="status" className="text-sm text-foreground-muted">
            加载中…
          </p>
        )}
      </div>
    )
  }

  const execution = activeExecution
  const task = currentTask
  let sections: MessageSection[] = (execution.DisplayMessages ?? []).flatMap((message) =>
    normalizePersistedSections(message.sections ?? [])
  )
  const fallbackContent =
    execution.Status === 'failed'
      ? `## 本次执行失败\n\n${execution.ErrorMessage || '任务未能完成，未提供更多错误信息。'}`
      : execution.Status === 'completed'
        ? execution.ResultMessage || '本次执行已完成，但没有返回可展示的内容。'
        : undefined
  if (fallbackContent && !sections.some((section) => section.type === 'content')) {
    sections = [
      ...sections,
      {
        type: 'content',
        content: fallbackContent,
        timestamp: new Date(execution.CompletedAt || execution.ScheduledAt).getTime(),
      },
    ]
  }

  return (
    <div className="h-full overflow-y-auto px-5 pb-16 pt-4 sm:px-6">
      <div className="mx-auto w-full max-w-[760px]">
        <ScheduledExecutionHeader
          taskTitle={taskTitle(task)}
          executionTitle={formatDateTime(execution.ScheduledAt)}
          status={execution.Status}
          durationLabel={formatExecutionDuration(execution.StartedAt, execution.CompletedAt)}
          triggerLabel="按计划自动触发"
          plannedLabel={
            timeOnly(execution.ScheduledAt) ?? formatShortDateTime(execution.ScheduledAt)
          }
          startedLabel={timeOnly(execution.StartedAt)}
          completedLabel={timeOnly(execution.CompletedAt)}
          backLabel="执行记录"
          onBack={onBack}
        />

        {execution.Status === 'pending' && sections.length === 0 ? (
          <p role="status" className="py-16 text-center text-sm text-foreground-muted">
            等待执行…
          </p>
        ) : execution.Status === 'running' && sections.length === 0 ? (
          <p role="status" className="py-16 text-center text-sm text-foreground-muted">
            正在执行，结果尚未生成…
          </p>
        ) : (
          <div className="mt-7">
            <MessageCard
              sections={sections.length > 0 ? sections : undefined}
              terminalStatus={
                execution.Status === 'failed'
                  ? 'failed'
                  : execution.Status === 'completed'
                    ? 'completed'
                    : undefined
              }
              isStreaming={execution.Status === 'running'}
            />
          </div>
        )}
      </div>
    </div>
  )
}
