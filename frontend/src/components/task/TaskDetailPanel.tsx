import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ScheduledTaskHeader } from '@/components/retroui/ScheduledTaskHeader'
import { ScheduledTaskHistory } from '@/components/retroui/ScheduledTaskHistory'
import { ScheduledTaskOverview } from '@/components/retroui/ScheduledTaskOverview'
import type { ScheduledTaskDetailTab } from '@/components/retroui/scheduledTaskTypes'
import { formatShortDateTime, isAbsentTime } from '@/lib/datetime'
import { useTaskStore } from '@/stores/task-store'

import {
  formatScheduleLabel,
  taskInstruction,
  taskTitle,
  toScheduledTaskLifecycle,
  toScheduledTaskRunSummary,
} from './scheduledTaskPresentation'
import { TaskActionsMenu } from './TaskActionsMenu'

interface TaskDetailPanelProps {
  taskId: string
  activeTab: ScheduledTaskDetailTab
  backLabel: string
  onBack: () => void
  onTabChange: (tab: ScheduledTaskDetailTab) => void
  onDeleted: () => void
  onViewExecution: (executionId: string) => void
}

/** 任务详情业务容器：负责取数与动作，视觉由 Design System 组件提供。 */
export function TaskDetailPanel({
  taskId,
  activeTab,
  backLabel,
  onBack,
  onTabChange,
  onDeleted,
  onViewExecution,
}: TaskDetailPanelProps) {
  const currentTask = useTaskStore((state) => state.currentTask)
  const currentTaskLoading = useTaskStore((state) => state.currentTaskLoading)
  const executions = useTaskStore((state) => state.executions)
  const executionsLoading = useTaskStore((state) => state.executionsLoading)
  const executionsNextCursor = useTaskStore((state) => state.executionsNextCursor)
  const executionViewStates = useTaskStore((state) => state.executionViewStates)
  const error = useTaskStore((state) => state.error)
  const loadTaskDetail = useTaskStore((state) => state.loadTaskDetail)
  const loadExecutions = useTaskStore((state) => state.loadExecutions)
  const loadExecutionViewStates = useTaskStore((state) => state.loadExecutionViewStates)
  const toggleTaskActive = useTaskStore((state) => state.toggleTaskActive)
  const deleteTask = useTaskStore((state) => state.deleteTask)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [pendingAction, setPendingAction] = useState<'toggle' | 'delete' | null>(null)
  const [previousTaskId, setPreviousTaskId] = useState(taskId)
  const deleteTimerRef = useRef<number | null>(null)

  if (previousTaskId !== taskId) {
    setPreviousTaskId(taskId)
    setConfirmingDelete(false)
    setPendingAction(null)
  }

  useEffect(() => {
    void loadTaskDetail(taskId)
    void loadExecutions(taskId)
  }, [taskId, loadExecutions, loadTaskDetail])

  useEffect(() => {
    const ids = executions
      .filter((execution) => execution.TaskID === taskId)
      .map((execution) => execution.ExecutionID)
    if (ids.length > 0) void loadExecutionViewStates(ids)
  }, [executions, loadExecutionViewStates, taskId])

  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current)
    }
  }, [])

  async function handleToggleActive(): Promise<void> {
    if (pendingAction) return
    const wasActive = currentTask?.IsActive
    setPendingAction('toggle')
    try {
      await toggleTaskActive(taskId)
      const actionError = useTaskStore.getState().error
      if (actionError) toast.error(actionError)
      else toast.success(wasActive ? '已暂停' : '已启用')
    } finally {
      setPendingAction(null)
    }
  }

  async function handleDelete(): Promise<void> {
    if (pendingAction) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      deleteTimerRef.current = window.setTimeout(() => setConfirmingDelete(false), 3000)
      return
    }
    if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current)
    setPendingAction('delete')
    await deleteTask(taskId)
    const actionError = useTaskStore.getState().error
    setPendingAction(null)
    if (actionError) {
      toast.error(actionError)
      setConfirmingDelete(false)
      return
    }
    toast.success('已删除任务')
    onDeleted()
  }

  if (currentTaskLoading || !currentTask || currentTask.TaskID !== taskId) {
    return (
      <div className="flex h-full items-center justify-center">
        {error && !currentTaskLoading ? (
          <div className="text-center">
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
            <button
              type="button"
              className="mt-3 min-h-11 cursor-pointer bg-transparent px-0 text-xs text-primary underline underline-offset-2 sm:min-h-0"
              onClick={() => void loadTaskDetail(taskId)}
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

  const title = taskTitle(currentTask)
  const lifecycle = toScheduledTaskLifecycle(currentTask)
  const history = executions
    .filter((execution) => execution.TaskID === taskId)
    .map((execution) =>
      toScheduledTaskRunSummary(execution, executionViewStates[execution.ExecutionID])
    )
  const latest = history[0]
  const historyCount = executionsNextCursor ? undefined : history.length
  const nextRunLabel =
    lifecycle === 'active'
      ? isAbsentTime(currentTask.NextRunAt)
        ? '等待下次调度'
        : `下次 ${formatShortDateTime(currentTask.NextRunAt)}`
      : lifecycle === 'paused'
        ? '暂停期间不执行'
        : '已结束'

  return (
    <div className="h-full overflow-y-auto px-5 pb-16 pt-4 sm:px-6">
      <div className="mx-auto w-full max-w-[760px]">
        <ScheduledTaskHeader
          title={title}
          kindLabel={currentTask.ScheduleType === 'recurring' ? '周期任务' : '单次任务'}
          lifecycle={lifecycle}
          activeTab={activeTab}
          historyCount={historyCount}
          backLabel={backLabel}
          onBack={onBack}
          onTabChange={onTabChange}
          primaryAction={
            lifecycle !== 'ended' ? (
              <button
                type="button"
                onClick={() => void handleToggleActive()}
                disabled={pendingAction === 'toggle'}
                aria-busy={pendingAction === 'toggle'}
                className="min-h-11 cursor-pointer border-0 bg-transparent px-0 text-xs text-foreground-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0"
              >
                {pendingAction === 'toggle'
                  ? currentTask.IsActive
                    ? '正在暂停…'
                    : '正在启用…'
                  : currentTask.IsActive
                    ? '暂停'
                    : '启用'}
              </button>
            ) : undefined
          }
          moreAction={
            <TaskActionsMenu
              taskTitle={title}
              confirmingDelete={confirmingDelete}
              deleting={pendingAction === 'delete'}
              onDelete={() => void handleDelete()}
            />
          }
        />

        {activeTab === 'overview' ? (
          <ScheduledTaskOverview
            scheduleLabel={formatScheduleLabel(currentTask)}
            nextRunLabel={nextRunLabel}
            nextRunTone={lifecycle === 'active' ? 'success' : 'muted'}
            retryLabel="失败时自动重试"
            triggerLabel="计划自动触发"
            cron={currentTask.CronExpr || undefined}
            instruction={taskInstruction(currentTask)}
            latestRun={latest}
            onViewLatest={latest ? () => onViewExecution(latest.id) : undefined}
            onViewHistory={() => onTabChange('history')}
          />
        ) : (
          <ScheduledTaskHistory
            records={history}
            loading={executionsLoading}
            error={error}
            onRetry={() => void loadExecutions(taskId)}
            hasMore={Boolean(executionsNextCursor)}
            onLoadMore={() => void loadExecutions(taskId, executionsNextCursor ?? undefined)}
            onSelect={(execution) => onViewExecution(execution.id)}
          />
        )}
      </div>
    </div>
  )
}
