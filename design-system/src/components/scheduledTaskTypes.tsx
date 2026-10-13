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
  /** 执行记录唯一标识，用于列表 key 与「查看本次」定位。 */
  id: string
  /** 本次执行状态，决定状态文案与状态色，也是派生「需要关注」的依据。 */
  status: ScheduledTaskRunStatus
  /** 执行发生时间的展示文案，由调用方格式化后传入，组件不做换算。 */
  timeLabel: string
  /** 执行耗时文案；进行中或未结束时缺省，缺省即不渲染耗时片段。 */
  durationLabel?: string | undefined
  /** 本次执行结果摘要；缺省时视图回退为「本次执行没有摘要」。 */
  summary?: string | undefined
  /** 随执行附带的补充信息（如模型、错误码）；缺省则不渲染该行。 */
  meta?: string | undefined
  /** 是否有未读结果；为 true 时列表与历史展示未读标记。 */
  unread?: boolean | undefined
  /** 分组标题（如按日期分组）；仅在与上一条不同时渲染，缺省则该条不另起分组。 */
  groupLabel?: string | undefined
}

/** 任务列表项的展示模型；`latestRun` 缺省表示这个任务从未执行过。 */
export interface ScheduledTaskListItemData {
  /** 任务唯一标识，用于列表 key 与选中时回传给调用方。 */
  id: string
  /** 任务标题，列表的主标识文案。 */
  title: string
  /** 任务来源说明（如创建它的会话）；缺省则不渲染来源行。 */
  source?: string | undefined
  /** 执行计划文案（如「每天 9:00」），已格式化。 */
  scheduleLabel: string
  /** 下次运行时间文案；任务已结束或没有下次运行时缺省，缺省即不渲染该行。 */
  nextRunLabel?: string | undefined
  /** 任务生命周期三态，决定状态文案与状态色。 */
  lifecycle: ScheduledTaskLifecycle
  /** 最近一次执行摘要；缺省表示这个任务从未执行过，列表显示空态。 */
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
