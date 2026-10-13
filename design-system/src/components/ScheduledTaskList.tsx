'use client'

import type { ReactElement, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'
import {
  isScheduledTaskAttention,
  scheduledTaskLifecycleLabel,
  scheduledTaskRunLabel,
  type ScheduledTaskFilter,
  type ScheduledTaskLifecycle,
  type ScheduledTaskListItemData,
  type ScheduledTaskRunStatus,
} from './scheduledTaskTypes'

/** 任务列表的 Props；筛选与排序受控，`filterCounts` 用于在档位上显示条数。 */
export interface ScheduledTaskListProps {
  /** 任务列表全量数据；为空时整块展示空态而非表格。 */
  items: ScheduledTaskListItemData[]
  /** 当前筛选档位，受控；默认 `all`，即不做筛选。 */
  filter?: ScheduledTaskFilter | undefined
  /** 各档位的任务条数；用于在档位标签后显示数字，缺省或某档缺省则不显示数字。 */
  filterCounts?: Partial<Record<ScheduledTaskFilter, number>> | undefined
  /** 切换筛选档位的回调；缺省时档位不可交互，点击不生效。 */
  onFilterChange?: ((filter: ScheduledTaskFilter) => void) | undefined
  /** 选中任务主体的回调，点击标题区域时触发。 */
  onSelectTask: (item: ScheduledTaskListItemData) => void
  /** 选中最近一次执行的回调；缺省时最近执行区域按钮处于禁用态，无跳转。 */
  onSelectExecution?: ((item: ScheduledTaskListItemData) => void) | undefined
  /** 行尾动作槽位的渲染函数；缺省时渲染一个箭头提示可进入。 */
  renderActions?: ((item: ScheduledTaskListItemData) => ReactNode) | undefined
  /** 是否加载中；默认 false。列表为空时展示整块加载态，已有数据时展示底部加载提示。 */
  loading?: boolean | undefined
  /** 错误文案；非空时展示告警条，并在提供 `onRetry` 时给出重试入口。 */
  error?: string | null | undefined
  /** 重试回调；仅在 `error` 非空且提供了该回调时渲染重试按钮。 */
  onRetry?: (() => void) | undefined
  /** 排序按钮文案，默认「按下次执行」；仅在提供 `onSort` 时渲染该按钮。 */
  sortLabel?: string | undefined
  /** 排序回调；缺省时不渲染排序按钮。 */
  onSort?: (() => void) | undefined
}

/**
 * 筛选档位的呈现顺序与中文标签。
 *
 * 这是列表筛选栏的唯一事实来源：顺序即渲染顺序，`id` 与 `ScheduledTaskFilter` 一一对应，
 * 后端不提供档位列表，故在模块内固化，避免每次渲染重建。
 */
const FILTERS: readonly { id: ScheduledTaskFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '启用' },
  { id: 'attention', label: '需要关注' },
  { id: 'paused', label: '已暂停' },
  { id: 'ended', label: '已结束' },
]

/**
 * 把档位条数渲染成按钮后缀。
 *
 * 计数未知时返回空串，使按钮不出现孤立的数字或占位符；计数为 0 时照常显示 0，
 * 因为「该档位确实没有任务」本身是有信息量的。
 *
 * @param count - 该档位的任务条数；undefined 表示尚未统计。
 * @returns 以空格开头的数字后缀，或计数未知时的空串。
 */
function filterCountLabel(count: number | undefined): string {
  return count === undefined ? '' : ` ${count}`
}

/**
 * 生命周期 → 状态文字颜色类。
 *
 * 仅「启用」用成功色强调，暂停与已结束统一降为弱化色，让活跃任务在列表中先被看到。
 * 两套主题各有一份 `text-success` / `text-foreground-muted`，语义色在两套主题下都可读。
 *
 * @param lifecycle - 任务生命周期三态。
 * @returns Tailwind 文字颜色类名。
 */
function lifecycleClass(lifecycle: ScheduledTaskLifecycle): string {
  return lifecycle === 'active' ? 'text-success' : 'text-foreground-muted'
}

/**
 * 执行状态 → 文本颜色类。
 *
 * 成功用成功色、失败用危险色，等待与进行中降为弱化色，使失败最先被注意。
 * 颜色取语义令牌，Light / Dark 两套主题下均保持可读。
 *
 * @param status - 单次执行的状态。
 * @returns Tailwind 文字颜色类名；未知状态回退到弱化色，不会漏样式。
 */
function runStatusClass(status: ScheduledTaskRunStatus): string {
  if (status === 'completed') return 'text-success'
  if (status === 'failed') return 'text-danger'
  return 'text-foreground-muted'
}

/**
 * 执行状态 → 状态圆点背景类。
 *
 * 与 {@link runStatusClass} 同一套映射，保证圆点与文案颜色一致；进行中会由调用方再叠加
 * 呼吸动画。语义色在两套主题下都有对应令牌。
 *
 * @param status - 单次执行的状态。
 * @returns Tailwind 背景色类名；未知状态回退到弱化色。
 */
function runStatusIndicatorClass(status: ScheduledTaskRunStatus): string {
  if (status === 'completed') return 'bg-success-indicator'
  if (status === 'failed') return 'bg-danger-indicator'
  return 'bg-foreground-muted'
}

/**
 * 判断任务是否落在某个筛选档位内。
 *
 * `attention` 是前端派生档：以「最近一次执行失败」为准，而不是后端状态字段；
 * `all` 恒真，其余档位比对生命周期。这样筛选逻辑与 {@link isScheduledTaskAttention}
 * 保持单一判据，不会两处各写一份。
 *
 * @param item - 待判定的任务列表项。
 * @param filter - 目标筛选档位。
 * @returns 该任务是否应出现在此档位下。
 */
function matchesFilter(item: ScheduledTaskListItemData, filter: ScheduledTaskFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'attention') return isScheduledTaskAttention(item)
  if (filter === 'active') return item.lifecycle === 'active'
  if (filter === 'paused') return item.lifecycle === 'paused'
  return item.lifecycle === 'ended'
}

/**
 * 定时任务索引。任务生命周期与最近运行状态分列表达，“需要关注”始终由最近失败派生。
 *
 * @param props - 组件属性；字段语义见 `ScheduledTaskListProps`。
 */
export function ScheduledTaskList(props: ScheduledTaskListProps) {
  const {
    items,
    filter = 'all',
    filterCounts,
    onFilterChange,
    onSelectTask,
    onSelectExecution,
    renderActions,
    loading = false,
    error,
    onRetry,
    sortLabel = '按下次执行',
    onSort,
  } = props
  const visibleItems = items.filter((item) => matchesFilter(item, filter))

  /** 渲染一行定时任务：标题、计划、最近执行、生命周期与动作槽位。 */
  function renderTaskItem(item: ScheduledTaskListItemData): ReactElement {
    const latestRun = item.latestRun
    return (
      <li
        key={item.id}
        className="grid min-h-[89px] grid-cols-[minmax(260px,1.45fr)_minmax(150px,.82fr)_minmax(170px,.9fr)_86px_36px] items-center gap-x-[18px] border-b border-border px-4 py-[15px] transition-colors last:border-b-0 hover:bg-surface-hover focus-within:bg-surface-hover max-[860px]:grid-cols-[minmax(220px,1.25fr)_minmax(140px,.8fr)_minmax(145px,.85fr)_74px_34px] max-[860px]:gap-x-3 max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:gap-x-3.5 max-[700px]:gap-y-2.5 max-[700px]:px-0.5"
      >
        <button
          type="button"
          onClick={() => onSelectTask(item)}
          className="min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left max-[700px]:col-start-1 max-[700px]:row-start-1"
        >
          <span className="flex min-w-0 items-center gap-2 font-sans text-sm font-semibold leading-6 text-foreground">
            <span className="truncate max-[700px]:whitespace-normal">{item.title}</span>
            {latestRun?.unread && (
              <span
                aria-label="有未读执行结果"
                className="h-[5px] w-[5px] shrink-0 rounded-full bg-brand-indicator"
              />
            )}
          </span>
          {item.source && (
            <span className="mt-1 block truncate font-sans text-xs leading-[1.4] text-foreground-muted max-[700px]:whitespace-normal">
              {item.source}
            </span>
          )}
        </button>

        <div className="min-w-0 max-[700px]:col-start-1 max-[700px]:row-start-2">
          <span className="block font-sans text-xs leading-6 text-foreground-secondary">
            <span className="hidden text-foreground-muted max-[700px]:inline">计划 · </span>
            {item.scheduleLabel}
          </span>
          {item.nextRunLabel && (
            <span className="mt-0.5 block truncate font-sans text-xs text-foreground-muted max-[700px]:whitespace-normal">
              {item.nextRunLabel}
            </span>
          )}
        </div>

        {latestRun ? (
          <button
            type="button"
            onClick={() => onSelectExecution?.(item)}
            disabled={!onSelectExecution}
            className="min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left disabled:cursor-default max-[700px]:col-start-1 max-[700px]:row-start-3"
          >
            <span
              className={cn(
                'flex items-center gap-1.5 font-sans text-xs leading-6',
                runStatusClass(latestRun.status)
              )}
            >
              <span className="hidden text-foreground-muted max-[700px]:inline">最近 ·</span>
              <span
                aria-hidden="true"
                className={cn(
                  'h-[5px] w-[5px] shrink-0 rounded-full',
                  runStatusIndicatorClass(latestRun.status),
                  latestRun.status === 'running' &&
                    'motion-safe:animate-[process-breathe_1.8s_ease-in-out_infinite]'
                )}
              />
              {scheduledTaskRunLabel(latestRun.status)}
            </span>
            <span
              className={cn(
                'mt-0.5 block truncate font-sans text-xs text-foreground-muted max-[700px]:whitespace-normal',
                latestRun.status === 'failed' && 'text-danger'
              )}
            >
              {latestRun.summary ||
                [latestRun.timeLabel, latestRun.durationLabel].filter(Boolean).join(' · ')}
            </span>
          </button>
        ) : (
          <span className="text-xs text-foreground-faint max-[700px]:col-start-1 max-[700px]:row-start-3">
            <span className="hidden max-[700px]:inline">最近 · </span>
            暂无执行摘要
          </span>
        )}

        <span
          className={cn(
            'inline-flex items-center gap-1.5 justify-self-start whitespace-nowrap font-sans text-xs',
            lifecycleClass(item.lifecycle),
            'max-[700px]:col-start-2 max-[700px]:row-start-1'
          )}
        >
          {scheduledTaskLifecycleLabel(item.lifecycle)}
        </span>

        <div className="max-[700px]:col-start-2 max-[700px]:row-start-2 max-[700px]:row-end-4 max-[700px]:self-center">
          {renderActions ? (
            renderActions(item)
          ) : (
            <ChevronRight
              aria-hidden="true"
              className="h-4 w-4 text-foreground-faint"
              strokeWidth={1.4}
            />
          )}
        </div>
      </li>
    )
  }

  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div role="group" aria-label="筛选定时任务" className="flex min-w-0 gap-5 overflow-x-auto">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => onFilterChange?.(item.id)}
              className={cn(
                'relative min-h-11 shrink-0 cursor-pointer border-0 bg-transparent px-0 py-2 font-sans text-xs text-foreground-muted sm:min-h-0',
                filter === item.id &&
                  'font-semibold text-brand-text after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-brand-indicator'
              )}
            >
              {item.label}
              {filterCountLabel(filterCounts?.[item.id])}
            </button>
          ))}
        </div>
        {onSort && (
          <button
            type="button"
            onClick={onSort}
            className="min-h-11 shrink-0 cursor-pointer border-0 bg-transparent px-0 py-2 font-sans text-xs text-foreground-muted hover:text-foreground sm:min-h-0"
          >
            {sortLabel} ↕
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-3 border-l-2 border-danger py-1 pl-3">
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

      {!(error && items.length === 0) && (
        <div className="overflow-visible rounded-xl border border-border-strong max-[700px]:rounded-none max-[700px]:border-x-0">
          <div
            aria-hidden="true"
            className="grid grid-cols-[minmax(260px,1.45fr)_minmax(150px,.82fr)_minmax(170px,.9fr)_86px_36px] items-center gap-x-[18px] border-b border-border px-4 py-[11px] font-sans text-xs text-foreground-muted max-[860px]:grid-cols-[minmax(220px,1.25fr)_minmax(140px,.8fr)_minmax(145px,.85fr)_74px_34px] max-[860px]:gap-x-3 max-[700px]:hidden"
          >
            <span>任务</span>
            <span>计划</span>
            <span>最近执行</span>
            <span>状态</span>
            <span />
          </div>

          {loading && items.length === 0 ? (
            <p role="status" className="m-0 py-16 text-center text-sm text-foreground-muted">
              加载中…
            </p>
          ) : visibleItems.length === 0 ? (
            <div className="px-5 py-14 text-center">
              <p className="m-0 font-sans text-[15px] text-foreground-muted">
                {items.length === 0 ? '还没有定时任务' : '此筛选下暂无任务'}
              </p>
              {items.length === 0 && (
                <p className="mt-2 text-xs text-foreground-faint">
                  在会话中告诉年糕你希望何时自动处理什么事情。
                </p>
              )}
            </div>
          ) : (
            <ul className="m-0 list-none p-0">{visibleItems.map(renderTaskItem)}</ul>
          )}
        </div>
      )}

      {loading && items.length > 0 && (
        <p role="status" className="m-0 py-3 text-center text-xs text-foreground-muted">
          加载中…
        </p>
      )}
    </div>
  )
}
