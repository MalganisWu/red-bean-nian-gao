import { TaskDetailPanel } from '@/components/task/TaskDetailPanel'
import type { ScheduledTaskDetailTab } from '@/components/retroui/scheduledTaskTypes'

/** 会话内任务详情视图属性：任务与页签状态，以及返回、切页签、查看执行三项回调。 */
interface SessionTaskDetailViewProps {
  /** 要展示的任务 id。 */
  taskId: string
  /** 当前选中的页签（详情 / 执行历史）。 */
  activeTab: ScheduledTaskDetailTab
  /** 点击返回时触发。 */
  onBack: () => void
  /**
   * 切换页签时触发，由调用方更新并透传 activeTab。
   * @param tab - 目标页签（详情 / 执行历史）；调用方据此更新并透传回 activeTab。
   */
  onTabChange: (tab: ScheduledTaskDetailTab) => void
  /**
   * 查看某次执行详情时触发，携带执行 id。
   * @param executionId - 目标执行的 id；调用方据此加载对应的执行详情。
   */
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
