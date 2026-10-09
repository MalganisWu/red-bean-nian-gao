'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolItem } from './ToolItem'
import type { ReasonItem } from './ReasoningBlock'

export type DelegationStatus =
  'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled' | 'incomplete'

export interface DelegationBlockProps {
  agentName: string
  status: DelegationStatus
  duration?: string | undefined
  items: ReasonItem[]
  output?: string | undefined
  summary?: string | undefined
  defaultExpanded?: boolean | undefined
}

const STATUS_TEXT: Record<DelegationStatus, string> = {
  running: '正在执行',
  completed: '成功',
  failed: '失败',
  awaiting_user: '等待确认',
  cancelled: '已取消',
  incomplete: '未完成',
}

/** Process 内的紧凑子任务行；详情只增加一层缩进，不嵌套第二条 Process。 */
export function DelegationBlock({
  agentName,
  status,
  duration,
  items,
  output,
  summary,
  defaultExpanded,
}: DelegationBlockProps) {
  const [expanded, setExpanded] = useState(
    defaultExpanded ?? (status === 'running' || status === 'awaiting_user' || status === 'failed')
  )
  const hasDetail = items.length > 0 || Boolean(output)
  const rowClassName =
    'grid w-full min-w-0 grid-cols-[12px_auto_minmax(0,1fr)_auto] items-baseline gap-1.5 bg-transparent py-px text-left text-[12.5px] leading-[1.7] text-foreground-secondary min-[761px]:grid-cols-[12px_auto_minmax(0,1fr)_auto_auto] min-[761px]:gap-2'
  const rowContent = (
    <>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'h-3 w-3 text-foreground-faint transition-transform duration-150',
          expanded && 'rotate-90',
          !hasDetail && 'invisible'
        )}
        strokeWidth={1.35}
      />
      <span
        className="block min-w-0 truncate text-xs font-medium text-delegation-name"
        title={`委派 · ${agentName}`}
      >
        委派 · {agentName}
      </span>
      <span className="min-w-0 truncate text-foreground-muted" title={summary}>
        {summary}
      </span>
      {duration && (
        <span className="hidden whitespace-nowrap text-tool-duration min-[761px]:inline">
          {duration}
        </span>
      )}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          'whitespace-nowrap font-semibold',
          status === 'completed' && 'text-success',
          status === 'failed' && 'text-danger',
          (status === 'running' ||
            status === 'awaiting_user' ||
            status === 'cancelled' ||
            status === 'incomplete') &&
            'text-foreground-muted'
        )}
      >
        {STATUS_TEXT[status]}
      </span>
    </>
  )

  return (
    <div className="min-w-0 font-sans text-xs text-foreground-secondary">
      {hasDetail ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className={cn(rowClassName, 'cursor-pointer')}
        >
          {rowContent}
        </button>
      ) : (
        <div className={rowClassName}>{rowContent}</div>
      )}

      {hasDetail && expanded && (
        <div className="mb-[3px] ml-5 mt-1.5 border-l border-border-strong py-px pl-3 text-[10.5px] leading-[1.75] text-foreground-muted max-[760px]:ml-[17px]">
          <div className="space-y-2">
            {items.map((item, index) => {
              if (item.itemType === 'step') {
                return (
                  <p key={`step-${index}`} className="m-0">
                    {item.content}
                  </p>
                )
              }
              if (item.itemType === 'tool' && item.tool) {
                return <ToolItem key={`tool-${index}`} {...item.tool} />
              }
              return null
            })}
            {output && (
              <MarkdownRenderer
                content={output}
                className="delegation-output border-t border-border pt-2 text-foreground-secondary"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
