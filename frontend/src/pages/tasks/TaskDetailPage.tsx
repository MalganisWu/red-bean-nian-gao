import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { TaskDetailPanel } from '@/components/task/TaskDetailPanel'
import { ROUTES } from '@/lib/constants'
import type { ScheduledTaskDetailTab } from '@/components/retroui/scheduledTaskTypes'

/** 任务详情页；当前 Tab 存在查询参数里，因此刷新与分享链接都能停在同一个页签。 */
export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  if (!id) return null

  const activeTab: ScheduledTaskDetailTab =
    searchParams.get('tab') === 'history' ? 'history' : 'overview'

  function handleTabChange(tab: ScheduledTaskDetailTab): void {
    const next = new URLSearchParams(searchParams)
    if (tab === 'history') next.set('tab', 'history')
    else next.delete('tab')
    setSearchParams(next, { replace: true })
  }

  return (
    <main className="flex h-dvh bg-background">
      <div className="flex flex-1 flex-col min-w-0 max-w-3xl mx-auto w-full">
        <TaskDetailPanel
          taskId={id}
          activeTab={activeTab}
          backLabel="返回全部任务"
          onBack={() => void navigate(ROUTES.TASKS)}
          onTabChange={handleTabChange}
          onDeleted={() => void navigate(ROUTES.TASKS)}
          onViewExecution={(executionId: string) => {
            void navigate(
              ROUTES.TASK_EXECUTION_DETAIL.replace(':id', id).replace(':eid', executionId)
            )
          }}
        />
      </div>
    </main>
  )
}
