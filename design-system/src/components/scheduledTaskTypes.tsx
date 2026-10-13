/** 任务生命周期三态：启用 / 暂停 / 已结束。 */
export type ScheduledTaskLifecycle = 'active' | 'paused' | 'ended'
/** 单次执行的状态；与后端 `TaskExecutionStatus` 一一对应。 */
export type ScheduledTaskRunStatus = 'pending' | 'running' | 'completed' | 'failed'
/** 列表筛选档位；`attention` 是**前端派生档**（最近一次执行失败），不对应后端状态。 */
export type ScheduledTaskFilter = 'all' | 'active' | 'attention' | 'paused' | 'ended'
/** 任务详情的两个页签。 */
export type ScheduledTaskDetailTab = 'overview' | 'history'

/** 执行摘要的展示模型；`unread` 与 `groupLabel` 由视图侧补充，不是后端字段。 */
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

/** 任务列表项的展示模型；`latestRun` 缺省表示这个任务从未执行过。 */
export interface ScheduledTaskListItemData {
  id: string
  title: string
  source?: string | undefined
  scheduleLabel: string
  nextRunLabel?: string | undefined
  lifecycle: ScheduledTaskLifecycle
  latestRun?: ScheduledTaskRunSummary | undefined
}

/**
 * 「需要关注」的判据：最近一次执行失败。
 *
 * @param item - 任务列表项的展示模型。
 * @returns 最近一次执行为失败时为 true；从未执行或最近一次成功时为 false。
 */
export function isScheduledTaskAttention(item: ScheduledTaskListItemData): boolean {
  return item.latestRun?.status === 'failed'
}

/**
 * 生命周期 → 中文短标签。
 *
 * @param lifecycle - 任务生命周期三态。
 * @returns 中文短标签（启用 / 已暂停 / 已结束）。
 */
export function scheduledTaskLifecycleLabel(lifecycle: ScheduledTaskLifecycle): string {
  if (lifecycle === 'active') return '启用'
  if (lifecycle === 'paused') return '已暂停'
  return '已结束'
}

/**
 * 执行状态 → 中文短标签。
 *
 * @param status - 单次执行的状态。
 * @returns 中文短标签（成功 / 失败 / 进行中 / 等待执行）。
 */
export function scheduledTaskRunLabel(status: ScheduledTaskRunStatus): string {
  if (status === 'completed') return '成功'
  if (status === 'failed') return '失败'
  if (status === 'running') return '进行中'
  return '等待执行'
}
