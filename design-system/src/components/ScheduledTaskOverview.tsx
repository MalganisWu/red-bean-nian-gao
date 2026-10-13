import { cn } from '../lib/utils'
import { scheduledTaskRunLabel, type ScheduledTaskRunSummary } from './scheduledTaskTypes'

/** 任务概览面板的 Props；字段都是已格式化的展示文案，缺省即不渲染对应行。 */
export interface ScheduledTaskOverviewProps {
  /** 执行计划的主文案（如「每天 9:00」），已格式化。 */
  scheduleLabel: string
  /** 下次运行时间文案；缺省时该格显示占位符「—」。 */
  nextRunLabel?: string | undefined
  /** 下次运行文案的语气，默认 `success`（用成功色强调时间点）；传 `muted` 则降为弱化色。 */
  nextRunTone?: 'success' | 'muted' | undefined
  /** 失败处理策略文案；缺省时回退为「按任务策略处理」。 */
  retryLabel?: string | undefined
  /** 触发方式文案；缺省时回退为「计划自动触发」。 */
  triggerLabel?: string | undefined
  /** 时区名称；缺省则不显示「使用时区」说明。 */
  timezone?: string | undefined
  /** Cron 表达式；缺省时整个「高级信息」折叠区不渲染。 */
  cron?: string | undefined
  /** 创建任务时的原始要求；缺省时整个「任务内容」区块不渲染。 */
  instruction?: string | undefined
  /** 最近一次执行摘要；缺省时该区块显示「任务尚未执行」空态。 */
  latestRun?: ScheduledTaskRunSummary | undefined
  /** 点击「查看本次」的回调；缺省时不渲染该按钮。 */
  onViewLatest?: (() => void) | undefined
  /** 点击「查看全部执行记录」的回调；缺省时不渲染该入口。 */
  onViewHistory?: (() => void) | undefined
}

/**
 * 最近一次执行状态 → 文本颜色类。
 *
 * 成功用成功色、失败用危险色，等待与进行中降为弱化色，与列表、历史的映射保持一致，
 * 使同一状态在概览里不出现另一种颜色。语义色在两套主题下都成立。
 *
 * @param status - 最近一次执行的状态。
 * @returns Tailwind 文字颜色类名；未知状态回退到弱化色。
 */
function latestStatusClass(status: ScheduledTaskRunSummary['status']): string {
  if (status === 'completed') return 'text-success'
  if (status === 'failed') return 'text-danger'
  return 'text-foreground-muted'
}

/**
 * 最近一次执行状态 → 状态圆点背景类。
 *
 * 与 {@link latestStatusClass} 同一套映射，保证圆点与文案颜色一致；语义色在
 * Light / Dark 两套主题下都有对应令牌。
 *
 * @param status - 最近一次执行的状态。
 * @returns Tailwind 背景色类名；未知状态回退到弱化色。
 */
function latestStatusIndicatorClass(status: ScheduledTaskRunSummary['status']): string {
  if (status === 'completed') return 'bg-success-indicator'
  if (status === 'failed') return 'bg-danger-indicator'
  return 'bg-foreground-muted'
}

/**
 * 任务概览只呈现稳定定义与最近一次摘要，不承载完整运行历史。
 *
 * @param props - 组件属性；字段语义见 `ScheduledTaskOverviewProps`。
 */
export function ScheduledTaskOverview(props: ScheduledTaskOverviewProps) {
  const {
    scheduleLabel,
    nextRunLabel,
    nextRunTone = 'success',
    retryLabel,
    triggerLabel,
    timezone,
    cron,
    instruction,
    latestRun,
    onViewLatest,
    onViewHistory,
  } = props
  return (
    <div>
      <section className="pt-[31px]">
        <div className="mb-[17px] flex items-baseline justify-between gap-5">
          <h3 className="m-0 font-sans text-[13px] font-semibold text-foreground">运行安排</h3>
          {timezone && (
            <span className="font-sans text-xs text-foreground-muted">使用 {timezone} 时区</span>
          )}
        </div>
        <p className="m-0 font-sans text-[21px] font-semibold tracking-[-0.025em] text-foreground">
          {scheduleLabel}
        </p>
        <dl className="mt-[18px] grid grid-cols-3 gap-6 max-[700px]:grid-cols-1 max-[700px]:gap-[13px]">
          <div>
            <dt className="font-sans text-xs text-foreground-muted">下次运行</dt>
            <dd
              className={cn(
                'mt-[5px] font-sans text-xs leading-[1.55]',
                nextRunTone === 'success' ? 'text-success' : 'text-foreground-muted'
              )}
            >
              {nextRunLabel || '—'}
            </dd>
          </div>
          <div>
            <dt className="font-sans text-xs text-foreground-muted">失败处理</dt>
            <dd className="mt-[5px] font-sans text-xs leading-[1.55] text-foreground-secondary">
              {retryLabel || '按任务策略处理'}
            </dd>
          </div>
          <div>
            <dt className="font-sans text-xs text-foreground-muted">触发方式</dt>
            <dd className="mt-[5px] font-sans text-xs leading-[1.55] text-foreground-secondary">
              {triggerLabel || '计划自动触发'}
            </dd>
          </div>
        </dl>
        {cron && (
          <details className="mt-[17px]">
            <summary className="w-fit cursor-pointer font-sans text-xs text-foreground-muted">
              高级信息
            </summary>
            <code className="mt-2.5 block w-fit font-mono text-xs text-foreground-secondary">
              Cron · {cron}
            </code>
          </details>
        )}
      </section>

      {instruction && (
        <section className="mt-[31px] border-t border-border pt-[31px]">
          <div className="mb-[17px] flex items-baseline justify-between gap-5">
            <h3 className="m-0 font-sans text-[13px] font-semibold text-foreground">任务内容</h3>
            <span className="font-sans text-xs text-foreground-muted">创建任务时的原始要求</span>
          </div>
          <p className="m-0 whitespace-pre-wrap border-l border-border-strong pl-4 font-sans text-sm leading-[1.8] text-foreground-body [overflow-wrap:anywhere]">
            {instruction}
          </p>
        </section>
      )}

      <section className="mt-[31px] border-t border-border pt-[31px]">
        <div className="mb-[17px] flex items-baseline justify-between gap-5">
          <h3 className="m-0 font-sans text-[13px] font-semibold text-foreground">最近一次执行</h3>
          {latestRun && (
            <span className="font-sans text-xs text-foreground-muted">{latestRun.timeLabel}</span>
          )}
        </div>

        {latestRun ? (
          <div className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-start gap-5 border-y border-border py-4 max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:gap-x-3.5 max-[700px]:gap-y-[9px]">
            <span
              className={cn(
                'flex items-center gap-[7px] font-sans text-xs font-semibold max-[700px]:col-span-2',
                latestStatusClass(latestRun.status)
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-[5px] w-[5px] rounded-full',
                  latestStatusIndicatorClass(latestRun.status)
                )}
              />
              {scheduledTaskRunLabel(latestRun.status)}
            </span>
            <div className="min-w-0">
              <strong className="block truncate font-sans text-[12.5px] font-medium leading-[1.55] text-foreground-secondary max-[700px]:whitespace-normal">
                {latestRun.summary || '本次执行没有摘要'}
              </strong>
              <span className="mt-[5px] block font-sans text-xs text-foreground-muted">
                {[latestRun.meta, latestRun.durationLabel && `耗时 ${latestRun.durationLabel}`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {onViewLatest && (
              <button
                type="button"
                onClick={onViewLatest}
                className="min-h-11 cursor-pointer self-center border-0 bg-transparent px-0 font-sans text-xs text-primary sm:min-h-0"
              >
                查看本次
              </button>
            )}
          </div>
        ) : (
          <p className="m-0 border-y border-border py-8 text-center text-xs text-foreground-muted">
            任务尚未执行
          </p>
        )}

        {onViewHistory && (
          <button
            type="button"
            onClick={onViewHistory}
            className="mt-[13px] min-h-11 cursor-pointer border-0 bg-transparent px-0 font-sans text-xs text-primary sm:min-h-0"
          >
            查看全部执行记录 →
          </button>
        )}
      </section>
    </div>
  )
}
