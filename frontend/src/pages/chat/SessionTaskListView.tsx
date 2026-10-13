import { useEffect, useState } from 'react'

import { BackLink } from '@/components/layout/BackLink'
import { ScheduledTaskList } from '@/components/retroui/ScheduledTaskList'
import type {
  ScheduledTaskFilter,
  ScheduledTaskListItemData,
} from '@/components/retroui/scheduledTaskTypes'
import { toScheduledTaskListItem } from '@/components/task/scheduledTaskPresentation'
import { useChatStore } from '@/stores/chat-store'
import { useTaskStore } from '@/stores/task-store'

/** 会话内任务列表视图属性：返回回调，以及选中任务、选中某次执行两项导航回调。 */
interface SessionTaskListViewProps {
  /** 点击返回时触发。 */
  onBack: () => void
  /** 选中某个任务时触发，携带任务 id。 */
  onSelectTask: (taskId: string) => void
  /** 选中某次执行时触发，携带任务 id 与执行 id。 */
  onSelectExecution: (taskId: string, executionId: string) => void
}

/**
 * 会话内的任务列表视图；支持按生命周期筛选，并可进入任务详情或某次执行。
 *
 * @param props - 组件属性；字段语义见 `SessionTaskListViewProps`。
 */
export function SessionTaskListView(props: SessionTaskListViewProps) {
  const { onBack, onSelectTask, onSelectExecution } = props
  const [filter, setFilter] = useState<ScheduledTaskFilter>('all')
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const sessionTasks = useTaskStore((state) => state.sessionTasks)
  const sessionTasksLoading = useTaskStore((state) => state.sessionTasksLoading)
  const sessionTasksError = useTaskStore((state) => state.error)
  const executionViewStates = useTaskStore((state) => state.executionViewStates)
  const executionViewStatesFailed = useTaskStore((state) => state.executionViewStatesFailed)
  const loadSessionTasks = useTaskStore((state) => state.loadSessionTasks)
  const loadExecutionViewStates = useTaskStore((state) => state.loadExecutionViewStates)

  useEffect(() => {
    if (activeSessionId) void loadSessionTasks(activeSessionId)
  }, [activeSessionId, loadSessionTasks])

  /** 预取本会话各任务最近一次执行的视图状态（无执行记录的任务跳过）。 */
  function prefetchExecutionViewStates(): void {
    const executionIds = sessionTasks.flatMap((task) =>
      task.latest_execution ? [task.latest_execution.ExecutionID] : []
    )
    if (executionIds.length > 0) void loadExecutionViewStates(executionIds)
  }

  useEffect(prefetchExecutionViewStates, [loadExecutionViewStates, sessionTasks])

  const items = sessionTasks.map((task) =>
    toScheduledTaskListItem(
      task,
      task.latest_execution && !executionViewStatesFailed[task.latest_execution.ExecutionID]
        ? executionViewStates[task.latest_execution.ExecutionID]
        : undefined,
      { showSessionTitle: false }
    )
  )
  const filterCounts = {
    all: items.length,
    active: items.filter((item) => item.lifecycle === 'active').length,
    attention: items.filter((item) => item.latestRun?.status === 'failed').length,
    paused: items.filter((item) => item.lifecycle === 'paused').length,
    ended: items.filter((item) => item.lifecycle === 'ended').length,
  }

  function handleSelectExecution(item: ScheduledTaskListItemData): void {
    if (item.latestRun) onSelectExecution(item.id, item.latestRun.id)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-4 sm:px-6">
        <div className="mx-auto w-full max-w-[920px]">
          <BackLink label="返回聊天" onClick={onBack} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-5 sm:px-6">
        <div className="mx-auto w-full max-w-[920px]">
          <div className="mb-6">
            <h1 className="m-0 font-sans text-[26px] font-semibold tracking-[-0.035em] text-foreground max-[700px]:text-[23px]">
              本会话定时任务
            </h1>
            <p className="mt-2 text-xs leading-[1.6] text-foreground-muted">
              当前会话创建的任务与最近一次运行状态。
            </p>
          </div>

          <ScheduledTaskList
            items={items}
            filter={filter}
            filterCounts={filterCounts}
            onFilterChange={setFilter}
            onSelectTask={(item) => onSelectTask(item.id)}
            onSelectExecution={handleSelectExecution}
            loading={sessionTasksLoading}
            error={sessionTasksError}
            onRetry={() => activeSessionId && void loadSessionTasks(activeSessionId)}
          />
        </div>
      </div>
    </div>
  )
}
