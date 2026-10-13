import { Fragment, type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'
import { scheduledTaskRunLabel, type ScheduledTaskRunSummary } from './scheduledTaskTypes'

/** 执行历史列表的 Props；分页与排序都是受控的，数据获取与状态推进由调用方负责。 */
export interface ScheduledTaskHistoryProps {
  /** 已加载的执行记录，按调用方给定的顺序（默认最近优先）排列。 */
  records: ScheduledTaskRunSummary[]
  /** 选中一条执行记录时触发，回传该记录以跳转详情。 */
  onSelect: (record: ScheduledTaskRunSummary) => void
  /** 是否加载中；默认 false。记录为空时展示整块加载态，已有数据时展示底部加载提示。 */
  loading?: boolean | undefined
  /** 错误文案；非空时展示告警条，记录同时为空则不再渲染列表区。 */
  error?: string | null | undefined
  /** 重试回调；仅在 `error` 非空且提供该回调时渲染重试按钮。 */
  onRetry?: (() => void) | undefined
  /** 排序按钮文案，默认「最近优先」；仅在提供 `onSort` 时渲染该按钮。 */
  sortLabel?: string | undefined
  /** 排序回调；缺省时不渲染排序按钮。 */
  onSort?: (() => void) | undefined
  /** 是否还有更多记录；默认 false，为 true 且非加载中时展示「加载更多」。 */
  hasMore?: boolean | undefined
  /** 加载更多回调；缺省时即使 `hasMore` 为真也不渲染加载更多按钮。 */
  onLoadMore?: (() => void) | undefined
}

/**
 * 执行状态 → 文本颜色类。
 *
 * 成功用成功色、失败用危险色，等待与进行中降为弱化色，使失败记录在账本里最先被看到。
 * 颜色取语义令牌，Light / Dark 两套主题下都保持可读。
 *
 * @param status - 执行记录的状态。
 * @returns Tailwind 文字颜色类名；未知状态回退到弱化色。
 */
function statusClass(status: ScheduledTaskRunSummary['status']): string {
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
 * @param status - 执行记录的状态。
 * @returns Tailwind 背景色类名；未知状态回退到弱化色。
 */
function statusIndicatorClass(status: ScheduledTaskRunSummary['status']): string {
  if (status === 'completed') return 'bg-success-indicator'
  if (status === 'failed') return 'bg-danger-indicator'
  return 'bg-foreground-muted'
}

/**
 * 执行记录账本。只描述每次运行，不重复任务定义，也不复用 Process 时间线。
 *
 * @param props - 组件属性；字段语义见 `ScheduledTaskHistoryProps`。
 */
export function ScheduledTaskHistory(props: ScheduledTaskHistoryProps) {
  const {
    records,
    onSelect,
    loading = false,
    error,
    onRetry,
    sortLabel = '最近优先',
    onSort,
    hasMore = false,
    onLoadMore,
  } = props
  /** 渲染一条执行记录；分组标签只在与上一条不同时出现。 */
  function renderRecord(record: ScheduledTaskRunSummary, index: number): ReactElement {
    const previousGroup = records[index - 1]?.groupLabel
    return (
      <Fragment key={record.id}>
        {record.groupLabel && record.groupLabel !== previousGroup && (
          <p className="mb-1 mt-6 font-sans text-xs text-foreground-muted">{record.groupLabel}</p>
        )}
        <button
          type="button"
          onClick={() => onSelect(record)}
          className="grid min-h-[70px] w-full cursor-pointer grid-cols-[106px_105px_minmax(0,1fr)_auto] items-center gap-[18px] border-0 border-b border-border bg-transparent px-0.5 py-[13px] text-left transition-colors hover:bg-surface-hover max-[700px]:grid-cols-[88px_minmax(0,1fr)_auto] max-[700px]:gap-x-3 max-[700px]:gap-y-[9px]"
        >
          <span className="font-sans text-xs text-foreground-secondary">{record.timeLabel}</span>
          <span
            className={cn(
              'flex items-center gap-[7px] font-sans text-xs',
              statusClass(record.status),
              'max-[700px]:col-start-2'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-[5px] w-[5px] shrink-0 rounded-full',
                statusIndicatorClass(record.status),
                record.status === 'running' &&
                  'motion-safe:animate-[process-breathe_1.8s_ease-in-out_infinite]'
              )}
            />
            {scheduledTaskRunLabel(record.status)}
            {record.durationLabel ? ` · ${record.durationLabel}` : ''}
          </span>
          <span className="min-w-0 max-[700px]:col-span-2 max-[700px]:col-start-1 max-[700px]:row-start-2">
            <strong className="block truncate font-sans text-xs font-medium text-foreground-secondary max-[700px]:whitespace-normal">
              {record.summary || '本次执行没有摘要'}
            </strong>
            {record.meta && (
              <span className="mt-1 block font-sans text-xs text-foreground-muted">
                {record.meta}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2.5 text-foreground-faint max-[700px]:col-start-3 max-[700px]:row-span-2 max-[700px]:row-start-1">
            {record.unread && (
              <span className="flex items-center gap-[5px] font-sans text-xs text-brand-text">
                <span
                  aria-hidden="true"
                  className="h-[5px] w-[5px] rounded-full bg-brand-indicator"
                />
                未读
              </span>
            )}
            <ChevronRight aria-hidden="true" className="h-4 w-4" strokeWidth={1.4} />
          </span>
        </button>
      </Fragment>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-[18px] pt-[27px]">
        <p className="m-0 font-sans text-xs leading-[1.6] text-foreground-muted">
          运行历史只记录发生过的事件，不混入任务配置。
        </p>
        {onSort && (
          <button
            type="button"
            onClick={onSort}
            className="min-h-11 shrink-0 cursor-pointer border-0 bg-transparent px-0 font-sans text-xs text-foreground-muted hover:text-foreground sm:min-h-0"
          >
            {sortLabel} ↕
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="mt-4 border-l-2 border-danger py-1 pl-3">
          <p className="m-0 text-xs text-danger">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 min-h-11 cursor-pointer border-0 bg-transparent px-0 text-xs text-danger underline underline-offset-2 sm:min-h-0"
            >
              重试
            </button>
          )}
        </div>
      )}

      {error && records.length === 0 ? null : loading && records.length === 0 ? (
        <p role="status" className="m-0 py-16 text-center text-sm text-foreground-muted">
          加载中…
        </p>
      ) : records.length === 0 ? (
        <div className="mt-[15px] border-t border-border-strong py-16 text-center">
          <p className="m-0 font-sans text-[15px] text-foreground-muted">暂无执行记录</p>
          <p className="mt-2 text-xs text-foreground-faint">任务运行后，每次结果会记录在这里。</p>
        </div>
      ) : (
        <div className="mt-[15px] border-t border-border-strong">{records.map(renderRecord)}</div>
      )}

      {loading && records.length > 0 && (
        <p role="status" className="m-0 py-3 text-center text-xs text-foreground-muted">
          加载中…
        </p>
      )}

      {hasMore && !loading && onLoadMore && (
        <div className="pt-4 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            className="min-h-11 cursor-pointer border-0 bg-transparent px-0 text-xs text-primary sm:min-h-0"
          >
            加载更多…
          </button>
        </div>
      )}
    </div>
  )
}
