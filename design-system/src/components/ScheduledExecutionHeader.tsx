import { cn } from '../lib/utils'
import { scheduledTaskRunLabel, type ScheduledTaskRunStatus } from './scheduledTaskTypes'

/** 执行详情页头部的 Props；带 Label 后缀的字段都是**已格式化的展示文案**，组件自身不做时间换算。 */
export interface ScheduledExecutionHeaderProps {
  /** 所属任务标题，作为面包屑的第一段显示。 */
  taskTitle: string
  /** 本次执行的标题，作为页面主标题渲染。 */
  executionTitle: string
  /** 本次执行状态，决定状态文案、状态色与是否展示进行中动画。 */
  status: ScheduledTaskRunStatus
  /** 执行耗时文案；缺省或有值时都只是追加在状态后，缺省即不显示耗时片段。 */
  durationLabel?: string | undefined
  /** 触发方式文案（如「计划触发」「手动触发」）。 */
  triggerLabel: string
  /** 计划执行时间文案；已格式化，组件不做换算。 */
  plannedLabel: string
  /** 实际开始时间文案；缺省时该格显示「尚未开始」。 */
  startedLabel?: string | undefined
  /** 实际完成时间文案；缺省时该格显示「尚未完成」。 */
  completedLabel?: string | undefined
  /** 返回按钮文案，通常为上级视图名称。 */
  backLabel: string
  /** 点击返回按钮时触发。 */
  onBack: () => void
}

/**
 * 执行状态 → 文本颜色类。
 *
 * 成功用成功色、失败用危险色，等待与进行中降为弱化色。取出为独立函数是为了让状态与颜色
 * 的对应只有一处，页头与列表派生的执行视图不会各自漂移。语义色在 Light / Dark 两套主题下
 * 都保持可读。
 *
 * @param status - 本次执行状态。
 * @returns Tailwind 文字颜色类名；未知状态回退到弱化色。
 */
function statusClass(status: ScheduledTaskRunStatus): string {
  if (status === 'completed') return 'text-success'
  if (status === 'failed') return 'text-danger'
  return 'text-foreground-muted'
}

/**
 * 执行状态 → 状态圆点背景类。
 *
 * 与 {@link statusClass} 同一套映射，保证圆点与文案颜色一致；进行中由调用方再叠加呼吸动画。
 * 语义色在两套主题下都有对应令牌。
 *
 * @param status - 本次执行状态。
 * @returns Tailwind 背景色类名；未知状态回退到弱化色。
 */
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
