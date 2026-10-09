import { TaskDetailPanel } from '@/components/task/TaskDetailPanel'
import type { ScheduledTaskDetailTab } from '@/components/retroui/scheduledTaskTypes'

interface SessionTaskDetailViewProps {
  taskId: string
  activeTab: ScheduledTaskDetailTab
  onBack: () => void
  onTabChange: (tab: ScheduledTaskDetailTab) => void
  onViewExecution: (executionId: string) => void
}

export function SessionTaskDetailView({
  taskId,
  activeTab,
  onBack,
  onTabChange,
  onViewExecution,
}: SessionTaskDetailViewProps) {
  return (
    <TaskDetailPanel
      taskId={taskId}
      activeTab={activeTab}
      backLabel="返回任务列表"
      onBack={onBack}
      onTabChange={onTabChange}
      onDeleted={onBack}
      onViewExecution={onViewExecution}
    />
  )
}
