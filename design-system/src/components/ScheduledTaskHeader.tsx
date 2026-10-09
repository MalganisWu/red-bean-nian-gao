import type { ReactNode } from 'react'

import { cn } from '../lib/utils'
import {
  scheduledTaskLifecycleLabel,
  type ScheduledTaskDetailTab,
  type ScheduledTaskLifecycle,
} from './scheduledTaskTypes'

export interface ScheduledTaskHeaderProps {
  title: string
  source?: string | undefined
  kindLabel: string
  lifecycle: ScheduledTaskLifecycle
  activeTab: ScheduledTaskDetailTab
  historyCount?: number | undefined
  backLabel: string
  onBack: () => void
  onTabChange: (tab: ScheduledTaskDetailTab) => void
  primaryAction?: ReactNode | undefined
  moreAction?: ReactNode | undefined
  headingLevel?: 1 | 2 | undefined
}

/** 任务详情共享对象头：只描述任务本身，并承载概览 / 执行记录的稳定导航。 */
export function ScheduledTaskHeader({
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
}: ScheduledTaskHeaderProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'

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
        {(['overview', 'history'] as const).map((tab) => {
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
        })}
      </div>
    </header>
  )
}
