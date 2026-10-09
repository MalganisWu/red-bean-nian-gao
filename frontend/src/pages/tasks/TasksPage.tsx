import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { BackLink } from '@/components/layout/BackLink'
import { toScheduledTaskListItem } from '@/components/task/scheduledTaskPresentation'
import { ScheduledTaskList } from '@/components/retroui/ScheduledTaskList'
import type {
  ScheduledTaskFilter,
  ScheduledTaskListItemData,
} from '@/components/retroui/scheduledTaskTypes'
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll'
import { ROUTES } from '@/lib/constants'
import { useTaskStore } from '@/stores/task-store'

export function TasksPage() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<ScheduledTaskFilter>('all')
  const tasks = useTaskStore((state) => state.tasks)
  const tasksLoading = useTaskStore((state) => state.tasksLoading)
  const tasksError = useTaskStore((state) => state.error)
  const tasksNextCursor = useTaskStore((state) => state.tasksNextCursor)
  const executionViewStates = useTaskStore((state) => state.executionViewStates)
  const executionViewStatesFailed = useTaskStore((state) => state.executionViewStatesFailed)
  const loadTasks = useTaskStore((state) => state.loadTasks)
  const loadExecutionViewStates = useTaskStore((state) => state.loadExecutionViewStates)
  const reset = useTaskStore((state) => state.reset)
  const { listRef, handleScroll } = useInfiniteScroll(
    () => void loadTasks(tasksNextCursor ?? undefined),
    Boolean(tasksNextCursor),
    tasksLoading
  )

  useEffect(() => {
    reset()
    void loadTasks()
  }, [loadTasks, reset])

  useEffect(() => {
    const executionIds = tasks.flatMap((task) =>
      task.latest_execution ? [task.latest_execution.ExecutionID] : []
    )
    if (executionIds.length > 0) void loadExecutionViewStates(executionIds)
  }, [loadExecutionViewStates, tasks])

  const items = tasks.map((task) =>
    toScheduledTaskListItem(
      task,
      task.latest_execution && !executionViewStatesFailed[task.latest_execution.ExecutionID]
        ? executionViewStates[task.latest_execution.ExecutionID]
        : undefined
    )
  )
  const filterCounts = tasksNextCursor
    ? undefined
    : {
        all: items.length,
        active: items.filter((item) => item.lifecycle === 'active').length,
        attention: items.filter((item) => item.latestRun?.status === 'failed').length,
        paused: items.filter((item) => item.lifecycle === 'paused').length,
        ended: items.filter((item) => item.lifecycle === 'ended').length,
      }

  function handleSelectTask(item: ScheduledTaskListItemData): void {
    void navigate(ROUTES.TASK_DETAIL.replace(':id', item.id))
  }

  function handleSelectExecution(item: ScheduledTaskListItemData): void {
    if (!item.latestRun) return
    void navigate(
      ROUTES.TASK_EXECUTION_DETAIL.replace(':id', item.id).replace(':eid', item.latestRun.id)
    )
  }

  return (
    <main className="flex h-dvh bg-background">
      <div className="mx-auto flex w-full min-w-0 max-w-[968px] flex-col px-5 sm:px-6">
        <div className="pt-4">
          <BackLink label="返回聊天" onClick={() => void navigate(ROUTES.CHAT)} />
        </div>

        <div className="flex items-end justify-between gap-6 pb-6 pt-5 max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-2.5">
          <div>
            <h1 className="m-0 font-sans text-[26px] font-semibold tracking-[-0.035em] text-foreground max-[700px]:text-[23px]">
              定时任务
            </h1>
            <p className="mt-2 text-xs leading-[1.6] text-foreground-muted">
              先看任务是否按计划运行，再进入详情查看定义和历史。
            </p>
          </div>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-16" onScroll={handleScroll}>
          <ScheduledTaskList
            items={items}
            filter={filter}
            filterCounts={filterCounts}
            onFilterChange={setFilter}
            onSelectTask={handleSelectTask}
            onSelectExecution={handleSelectExecution}
            loading={tasksLoading}
            error={tasksError}
            onRetry={() => void loadTasks()}
          />
        </div>
      </div>
    </main>
  )
}
