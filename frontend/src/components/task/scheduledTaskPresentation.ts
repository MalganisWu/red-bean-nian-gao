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

/** cron 星期字段（0-7）到中文单字的映射；0 与 7 都指周日，故重复列出。 */
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

/**
 * 把时间字段补零到两位，供 `HH:mm` 文案拼接。
 *
 * @param value - cron 中解析出的时或分数字字符串。
 * @returns 左侧补 `0` 到两位的字符串；已是两位时原样返回。
 */
function padTimePart(value: string): string {
  return value.padStart(2, '0')
}

/**
 * 把结果或错误文本压成单行纯文本摘要，供列表一行展示。
 *
 * @param value - 原始 Markdown 文本；空值直接判为无摘要。
 * @returns 去除代码块、图片、链接与 Markdown 标记并截断到 72 字以内的摘要；清洗后为空则返回 `undefined`。
 */
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

/**
 * 把可空时间字符串解析为 `Date`；缺值、占位值与非法值统一判为不可用。
 *
 * @param value - ISO 时间字符串；`null`/`undefined` 或占位时间视为不可用。
 * @returns 可用的 `Date`；无法解析时返回 `undefined`，由调用方决定是否隐藏。
 */
function validDate(value: string | null | undefined): Date | undefined {
  if (!value || isAbsentTime(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * 任务标题：取 task_input 的首个非空行并截断到 48 字；输入为空时回落为「未命名任务」。
 *
 * @param task - 源任务；只读 `TaskInput`。
 * @returns 展示用标题，保证非空。
 */
export function taskTitle(task: Task): string {
  const source = task.TaskInput.trim() || '未命名任务'
  const firstLine =
    source
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || source
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine
}

/**
 * 完整指令文本；与标题相同时返回 `undefined`，避免详情页把同一句话渲染两遍。
 *
 * @param task - 源任务；只读 `TaskInput`。
 * @returns 与标题不同的完整指令；指令为空或与标题等价时返回 `undefined`。
 */
export function taskInstruction(task: Task): string | undefined {
  const instruction = task.TaskInput.trim()
  if (!instruction || instruction === taskTitle(task)) return undefined
  return instruction
}

/**
 * 由启用状态与调度类型推出生命周期：单次且已停 = 已结束，周期且已停 = 暂停。
 *
 * @param task - 源任务；读取 `IsActive` 与 `ScheduleType`。
 * @returns 生命周期三态之一。
 */
export function toScheduledTaskLifecycle(task: Task): ScheduledTaskLifecycle {
  if (task.IsActive) return 'active'
  return task.ScheduleType === 'once' ? 'ended' : 'paused'
}

/**
 * 把调度配置渲染成一行可读文案；只识别常见 cron 形态，认不出的一律回落为「周期任务」。
 *
 * @param task - 源任务；读取 `ScheduleType`、`RunAt` 与 `CronExpr`。
 * @returns 单行调度文案；无法解析的 cron 回落为「周期任务」。
 */
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

/**
 * 由起止时间算耗时；缺任一端或时间倒挂时返回 `undefined`，调用方据此隐藏耗时。
 *
 * @param startedAt - 开始时间（ISO 字符串）；缺失或非法时判为不可算。
 * @param completedAt - 完成时间（ISO 字符串）；早于开始时间时判为不可算。
 * @returns 形如 `"1.2s"` 的耗时文案，不足 1 秒返回 `"<1s"`；不可算时返回 `undefined`。
 */
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

/**
 * 把一次执行投影成列表摘要行：失败态展示错误、其余展示结果；`unread` 表示尚未被查看。
 *
 * @param execution - 执行记录或列表摘要；读取起止时间、状态与结果字段。
 * @param viewState - 该执行的查看态；缺失时 `unread` 为 `false`。
 * @returns Design System 列表组件可直接消费的摘要行。
 */
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
 *
 * @param task - 列表项源任务，含可选的 `latest_execution`。
 * @param viewState - 最近一次执行的查看态；缺失时该区块按未读处理。
 * @param options - 可选项；`showSessionTitle` 控制是否展示来源会话标题，默认展示。
 * @returns Design System 列表组件可直接消费的列表项数据。
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
