import { cn } from '../lib/utils'
import { scheduledTaskRunLabel, type ScheduledTaskRunStatus } from './scheduledTaskTypes'

/** 执行详情页头部的 Props；带 Label 后缀的字段都是**已格式化的展示文案**，组件自身不做时间换算。 */
export interface ScheduledExecutionHeaderProps {
  taskTitle: string
  executionTitle: string
  status: ScheduledTaskRunStatus
  durationLabel?: string | undefined
  triggerLabel: string
  plannedLabel: string
  startedLabel?: string | undefined
  completedLabel?: string | undefined
  backLabel: string
  onBack: () => void
}

function statusClass(status: ScheduledTaskRunStatus): string {
  if (status === 'completed') return 'text-success'
  if (status === 'failed') return 'text-danger'
  return 'text-foreground-muted'
}

function statusIndicatorClass(status: ScheduledTaskRunStatus): string {
  if (status === 'completed') return 'bg-success-indicator'
  if (status === 'failed') return 'bg-danger-indicator'
  return 'bg-foreground-muted'
}

/**
 * 单次执行页头。只描述本次运行，不重复任务配置或聊天事件外壳。
 *
 * @param props - 组件属性；字段语义见 `ScheduledExecutionHeaderProps`。
 */
export function ScheduledExecutionHeader(props: ScheduledExecutionHeaderProps) {
  const {
    taskTitle,
    executionTitle,
    status,
    durationLabel,
    triggerLabel,
    plannedLabel,
    startedLabel,
    completedLabel,
    backLabel,
    onBack,
  } = props
  return (
    <header>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-11 cursor-pointer items-center border-0 bg-transparent px-0 font-sans text-xs text-foreground-muted hover:text-foreground sm:min-h-0"
      >
        ‹ {backLabel}
      </button>

      <div className="mt-6 flex items-start justify-between gap-6 max-[700px]:flex-col max-[700px]:gap-[15px]">
        <div>
          <div className="mb-[9px] flex items-center gap-2 font-sans text-xs text-foreground-muted">
            <span>{taskTitle}</span>
            <span aria-hidden="true">·</span>
            <span>本次执行</span>
          </div>
          <h1 className="m-0 font-sans text-[26px] font-semibold leading-[1.35] tracking-[-0.035em] text-foreground max-[700px]:text-[23px]">
            {executionTitle}
          </h1>
          <p className="mt-[7px] font-sans text-xs text-foreground-muted">{triggerLabel}</p>
        </div>
        <span
          className={cn(
            'mt-2 flex items-center gap-[7px] whitespace-nowrap font-sans text-xs font-semibold',
            statusClass(status)
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-[5px] w-[5px] rounded-full',
              statusIndicatorClass(status),
              status === 'running' &&
                'motion-safe:animate-[process-breathe_1.8s_ease-in-out_infinite]'
            )}
          />
          {scheduledTaskRunLabel(status)}
          {durationLabel ? ` · ${durationLabel}` : ''}
        </span>
      </div>

      <dl className="mt-6 grid grid-cols-3 gap-5 border-y border-border py-3.5 max-[700px]:grid-cols-1 max-[700px]:gap-[13px]">
        <div>
          <dt className="font-sans text-xs text-foreground-muted">计划</dt>
          <dd className="mt-[5px] font-sans text-xs text-foreground-secondary">{plannedLabel}</dd>
        </div>
        <div>
          <dt className="font-sans text-xs text-foreground-muted">开始</dt>
          <dd className="mt-[5px] font-sans text-xs text-foreground-secondary">
            {startedLabel || '尚未开始'}
          </dd>
        </div>
        <div>
          <dt className="font-sans text-xs text-foreground-muted">完成</dt>
          <dd className="mt-[5px] font-sans text-xs text-foreground-secondary">
            {completedLabel || '尚未完成'}
          </dd>
        </div>
      </dl>
    </header>
  )
}
