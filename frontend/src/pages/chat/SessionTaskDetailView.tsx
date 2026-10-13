import { TaskDetailPanel } from '@/components/task/TaskDetailPanel'
import type { ScheduledTaskDetailTab } from '@/components/retroui/scheduledTaskTypes'

interface SessionTaskDetailViewProps {
  taskId: string
  activeTab: ScheduledTaskDetailTab
  onBack: () => void
  onTabChange: (tab: ScheduledTaskDetailTab) => void
  onViewExecution: (executionId: string) => void
}

/**
 * 会话内的任务详情视图；以 Tab 在概览与执行历史之间切换。
 *
 * @param props - 组件属性；字段语义见 `SessionTaskDetailViewProps`。
 */
export function SessionTaskDetailView(props: SessionTaskDetailViewProps) {
  const { taskId, activeTab, onBack, onTabChange, onViewExecution } = props
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
