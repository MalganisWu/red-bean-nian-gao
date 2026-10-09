export type ScheduledTaskLifecycle = 'active' | 'paused' | 'ended'
export type ScheduledTaskRunStatus = 'pending' | 'running' | 'completed' | 'failed'
export type ScheduledTaskFilter = 'all' | 'active' | 'attention' | 'paused' | 'ended'
export type ScheduledTaskDetailTab = 'overview' | 'history'

export interface ScheduledTaskRunSummary {
  id: string
  status: ScheduledTaskRunStatus
  timeLabel: string
  durationLabel?: string | undefined
  summary?: string | undefined
  meta?: string | undefined
  unread?: boolean | undefined
  groupLabel?: string | undefined
}

export interface ScheduledTaskListItemData {
  id: string
  title: string
  source?: string | undefined
  scheduleLabel: string
  nextRunLabel?: string | undefined
  lifecycle: ScheduledTaskLifecycle
  latestRun?: ScheduledTaskRunSummary | undefined
}

export function isScheduledTaskAttention(item: ScheduledTaskListItemData): boolean {
  return item.latestRun?.status === 'failed'
}

export function scheduledTaskLifecycleLabel(lifecycle: ScheduledTaskLifecycle): string {
  if (lifecycle === 'active') return '启用'
  if (lifecycle === 'paused') return '已暂停'
  return '已结束'
}

export function scheduledTaskRunLabel(status: ScheduledTaskRunStatus): string {
  if (status === 'completed') return '成功'
  if (status === 'failed') return '失败'
  if (status === 'running') return '进行中'
  return '等待执行'
}
