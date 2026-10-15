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

/** 任务详情容器属性：任务与页签状态，以及返回、切页签、删除完成、查看执行四项回调。 */
interface TaskDetailPanelProps {
  /** 当前任务 id；变化时重新拉取详情与执行列表。 */
  taskId: string
  /** 当前选中的页签（详情 / 执行历史）。 */
  activeTab: ScheduledTaskDetailTab
  /** 返回入口的文案，由调用方给出上一层的名称。 */
  backLabel: string
  /** 点击返回时触发。 */
  onBack: () => void
  /**
   * 切换页签时触发，由调用方更新并透传 activeTab。
   * @param tab - 目标页签（详情 / 执行历史）；调用方据此更新并透传回 activeTab。
   */
  onTabChange: (tab: ScheduledTaskDetailTab) => void
  /** 任务删除成功后触发，供调用方做返回等收尾。 */
  onDeleted: () => void
  /**
   * 查看某次执行详情时触发，携带执行 id。
   * @param executionId - 目标执行的 id；调用方据此加载对应的执行详情。
   */
  onViewExecution: (executionId: string) => void
}

/**
 * 任务详情业务容器：负责取数与动作，视觉由 Design System 组件提供。
 *
 * @param props - 组件属性；字段语义见 `TaskDetailPanelProps`。
 */
export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const { taskId, activeTab, backLabel, onBack, onTabChange, onDeleted, onViewExecution } = props
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

  useEffect(loadTaskData, [taskId, loadExecutions, loadTaskDetail])
  useEffect(loadMissingViewStates, [executions, loadExecutionViewStates, taskId])
  useEffect(clearDeleteTimerOnUnmount, [])

  // 进入任务详情：并行加载任务本身与它的执行记录。
  function loadTaskData(): void {
    void loadTaskDetail(taskId)
    void loadExecutions(taskId)
  }

  // 执行记录变化后，补齐本次任务的执行展示状态。
  function loadMissingViewStates(): void {
    const ids = executions
      .filter((execution) => execution.TaskID === taskId)
      .map((execution) => execution.ExecutionID)
    if (ids.length > 0) void loadExecutionViewStates(ids)
  }

  // 卸载时清掉「删除」二次确认的计时器。
  function clearDeleteTimerOnUnmount(): () => void {
    return () => {
      if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current)
    }
  }

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
