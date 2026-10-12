import type {
  ScheduledTaskLifecycle,
  ScheduledTaskListItemData,
  ScheduledTaskRunSummary,
} from '@/components/retroui/scheduledTaskTypes'
import { formatShortDateTime, isAbsentTime } from '@/lib/datetime'
import type {
  ExecutionViewState,
  Task,
  TaskExecution,
  TaskExecutionSummary,
  TaskListItem,
} from '@/types/task'

const WEEKDAY_LABELS: Record<string, string> = {
  '0': '日',
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  '7': '日',
}

function padTimePart(value: string): string {
  return value.padStart(2, '0')
}

function plainSummary(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const plain = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*+-]+\s*/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return undefined
  return plain.length > 72 ? `${plain.slice(0, 71)}…` : plain
}

function validDate(value: string | null | undefined): Date | undefined {
  if (!value || isAbsentTime(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** 任务标题：取 task_input 的首个非空行并截断到 48 字；输入为空时回落为「未命名任务」。 */
export function taskTitle(task: Task): string {
  const source = task.TaskInput.trim() || '未命名任务'
  const firstLine =
    source
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || source
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine
}

/** 完整指令文本；与标题相同时返回 `undefined`，避免详情页把同一句话渲染两遍。 */
export function taskInstruction(task: Task): string | undefined {
  const instruction = task.TaskInput.trim()
  if (!instruction || instruction === taskTitle(task)) return undefined
  return instruction
}

/** 由启用状态与调度类型推出生命周期：单次且已停 = 已结束，周期且已停 = 暂停。 */
export function toScheduledTaskLifecycle(task: Task): ScheduledTaskLifecycle {
  if (task.IsActive) return 'active'
  return task.ScheduleType === 'once' ? 'ended' : 'paused'
}

/** 把调度配置渲染成一行可读文案；只识别常见 cron 形态，认不出的一律回落为「周期任务」。 */
export function formatScheduleLabel(task: Task): string {
  if (task.ScheduleType === 'once') {
    return isAbsentTime(task.RunAt) ? '单次任务' : `单次 · ${formatShortDateTime(task.RunAt)}`
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = task.CronExpr.trim().split(/\s+/)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return '周期任务'
  if (
    /^\*\/\d+$/.test(minute) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `每 ${minute.slice(2)} 分钟`
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === '*') {
    const time = `${padTimePart(hour)}:${padTimePart(minute)}`
    if (dayOfMonth === '*' && dayOfWeek === '*') return `每天 ${time}`
    if (dayOfMonth === '*' && WEEKDAY_LABELS[dayOfWeek]) {
      return `每周${WEEKDAY_LABELS[dayOfWeek]} ${time}`
    }
    if (/^\d+$/.test(dayOfMonth) && dayOfWeek === '*') return `每月 ${dayOfMonth} 日 ${time}`
  }
  return '周期任务'
}

/** 由起止时间算耗时；缺任一端或时间倒挂时返回 `undefined`，调用方据此隐藏耗时。 */
export function formatExecutionDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined
): string | undefined {
  const started = validDate(startedAt)
  const completed = validDate(completedAt)
  if (!started || !completed) return undefined
  const duration = completed.getTime() - started.getTime()
  if (duration < 0) return undefined
  if (duration < 1000) return '<1s'
  return `${(duration / 1000).toFixed(1)}s`
}

/** 把一次执行投影成列表摘要行：失败态展示错误、其余展示结果；`unread` 表示尚未被查看。 */
export function toScheduledTaskRunSummary(
  execution: TaskExecution | TaskExecutionSummary,
  viewState?: ExecutionViewState
): ScheduledTaskRunSummary {
  return {
    id: execution.ExecutionID,
    status: execution.Status,
    timeLabel: formatShortDateTime(execution.ScheduledAt),
    durationLabel: formatExecutionDuration(execution.StartedAt, execution.CompletedAt),
    summary: plainSummary(
      execution.Status === 'failed' ? execution.ErrorMessage : execution.ResultMessage
    ),
    unread: Boolean(viewState && !viewState.seen_at),
  }
}

/**
 * 把任务投影成列表项。
 * `nextRunLabel` 按生命周期三态给出不同措辞；`latest_execution` 缺失时不渲染最近一次执行区块。
 */
export function toScheduledTaskListItem(
  task: TaskListItem,
  viewState?: ExecutionViewState,
  options: { showSessionTitle?: boolean } = {}
): ScheduledTaskListItemData {
  const lifecycle = toScheduledTaskLifecycle(task)
  const showSessionTitle = options.showSessionTitle ?? true
  return {
    id: task.TaskID,
    title: taskTitle(task),
    source: showSessionTitle && task.session_title ? `会话 · ${task.session_title}` : undefined,
    scheduleLabel: formatScheduleLabel(task),
    nextRunLabel:
      lifecycle === 'active'
        ? isAbsentTime(task.NextRunAt)
          ? '等待下次调度'
          : `下次 ${formatShortDateTime(task.NextRunAt)}`
        : lifecycle === 'paused'
          ? '暂停期间不执行'
          : '已结束',
    lifecycle,
    latestRun: task.latest_execution
      ? toScheduledTaskRunSummary(task.latest_execution, viewState)
      : undefined,
  }
}
