import type { ReactElement, ReactNode } from 'react'

import { cn } from '../lib/utils'
import {
  scheduledTaskLifecycleLabel,
  type ScheduledTaskDetailTab,
  type ScheduledTaskLifecycle,
} from './scheduledTaskTypes'

/** 任务详情页头部的 Props；页签受控，两个动作槽位由调用方注入现成按钮。 */
export interface ScheduledTaskHeaderProps {
  /** 任务标题，作为页面的主标题渲染。 */
  title: string
  /** 任务来源说明；缺省则不渲染标题下方该行。 */
  source?: string | undefined
  /** 任务类型短标签（如「定时任务」），与状态并列显示在标题上方。 */
  kindLabel: string
  /** 任务生命周期三态，决定状态文案与是否强调为成功色。 */
  lifecycle: ScheduledTaskLifecycle
  /** 当前选中的页签，受控；由调用方持有并决定高亮项。 */
  activeTab: ScheduledTaskDetailTab
  /** 执行记录条数；仅在「执行记录」页签且非 undefined 时追加显示。 */
  historyCount?: number | undefined
  /** 返回按钮文案，通常为上级视图名称。 */
  backLabel: string
  /** 点击返回按钮时触发。 */
  onBack: () => void
  /**
   * 切换页签时触发，回传目标页签。
   * @param tab - 被点击的目标页签，调用方据此更新受控的 `activeTab`。
   */
  onTabChange: (tab: ScheduledTaskDetailTab) => void
  /** 主操作槽位，由调用方注入现成按钮；缺省且无 `moreAction` 时不渲染操作区。 */
  primaryAction?: ReactNode | undefined
  /** 次级操作槽位，由调用方注入现成按钮；缺省则只渲染主操作。 */
  moreAction?: ReactNode | undefined
  /** 标题标签层级；默认 2（h2），嵌入页面主区域时可传 1 提升为 h1。 */
  headingLevel?: 1 | 2 | undefined
}

/**
 * 任务详情共享对象头：只描述任务本身，并承载概览 / 执行记录的稳定导航。
 *
 * @param props - 组件属性；字段语义见 `ScheduledTaskHeaderProps`。
 */
export function ScheduledTaskHeader(props: ScheduledTaskHeaderProps) {
  const {
    title,
    source,
    kindLabel,
    lifecycle,
    activeTab,
    historyCount,
    backLabel,
    onBack,
    onTabChange,
    primaryAction,
    moreAction,
    headingLevel = 2,
  } = props
  const Heading = headingLevel === 1 ? 'h1' : 'h2'

  /** 渲染一个详情页签：选中态由 `activeTab` 决定，历史页签附带条数。 */
  function renderTab(tab: ScheduledTaskDetailTab): ReactElement {
    const selected = activeTab === tab
    const label = tab === 'overview' ? '概览' : '执行记录'
    return (
      <button
        key={tab}
        type="button"
        aria-pressed={selected}
        onClick={() => onTabChange(tab)}
        className={cn(
          'relative min-h-11 cursor-pointer border-0 bg-transparent px-0 py-2 font-sans text-xs text-foreground-muted sm:min-h-0',
          selected &&
            'font-semibold text-brand-text after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-brand-indicator'
        )}
      >
        {label}
        {tab === 'history' && historyCount !== undefined ? ` ${historyCount}` : ''}
      </button>
    )
  }

  return (
    <header>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-11 cursor-pointer items-center border-0 bg-transparent px-0 font-sans text-xs text-foreground-muted hover:text-foreground sm:min-h-0"
      >
        ‹ {backLabel}
      </button>

      <div className="mt-[22px] flex items-start justify-between gap-7 max-[700px]:flex-col max-[700px]:gap-[15px]">
        <div className="min-w-0">
          <div className="mb-[9px] flex items-center gap-2 font-sans text-xs text-foreground-muted">
            <span>{kindLabel}</span>
            <span aria-hidden="true">·</span>
            <span className={lifecycle === 'active' ? 'text-success' : 'text-foreground-muted'}>
              任务状态：{scheduledTaskLifecycleLabel(lifecycle)}
            </span>
          </div>
          <Heading className="m-0 break-words font-sans text-[26px] font-semibold leading-[1.35] tracking-[-0.035em] text-foreground max-[700px]:text-[23px]">
            {title}
          </Heading>
          {source && (
            <p className="mt-2 font-sans text-xs leading-[1.6] text-foreground-muted">{source}</p>
          )}
        </div>

        {(primaryAction || moreAction) && (
          <div className="flex shrink-0 items-center gap-[18px] max-[700px]:self-stretch max-[700px]:justify-end">
            {primaryAction}
            {moreAction}
          </div>
        )}
      </div>

      <div
        className="mt-[31px] flex gap-6 border-b border-border max-[700px]:mt-6"
        role="group"
        aria-label="任务详情视图"
      >
        {(['overview', 'history'] as const).map(renderTab)}
      </div>
    </header>
  )
}
