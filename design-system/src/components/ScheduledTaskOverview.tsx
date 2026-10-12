import { cn } from '../lib/utils'
import { scheduledTaskRunLabel, type ScheduledTaskRunSummary } from './scheduledTaskTypes'

/** 任务概览面板的 Props；字段都是已格式化的展示文案，缺省即不渲染对应行。 */
export interface ScheduledTaskOverviewProps {
  scheduleLabel: string
  nextRunLabel?: string | undefined
  nextRunTone?: 'success' | 'muted' | undefined
  retryLabel?: string | undefined
  triggerLabel?: string | undefined
  timezone?: string | undefined
  cron?: string | undefined
  instruction?: string | undefined
  latestRun?: ScheduledTaskRunSummary | undefined
  onViewLatest?: (() => void) | undefined
  onViewHistory?: (() => void) | undefined
}

function latestStatusClass(status: ScheduledTaskRunSummary['status']): string {
  if (status === 'completed') return 'text-success'
  if (status === 'failed') return 'text-danger'
  return 'text-foreground-muted'
}

function latestStatusIndicatorClass(status: ScheduledTaskRunSummary['status']): string {
  if (status === 'completed') return 'bg-success-indicator'
  if (status === 'failed') return 'bg-danger-indicator'
  return 'bg-foreground-muted'
}

/** 任务概览只呈现稳定定义与最近一次摘要，不承载完整运行历史。 */
export function ScheduledTaskOverview({
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
}: ScheduledTaskOverviewProps) {
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
