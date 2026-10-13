/**
 * 内部件：被 ProcessFold / ReasoningBlock / DelegationBlock 内部使用，
 * 不单独出 showcase 页。见 design-system/AGENTS.md「组件入册规则」。
 */
'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'

/** 工具行的 Props；`status` 决定配色与图标，`duration` 为已格式化的耗时文案。 */
export interface ToolItemProps {
  name: string
  callId?: string | undefined
  /** 当前工具调用承载一个子 Agent 委派。 */
  isDelegation?: boolean | undefined
  /** 工具作用目标；兼容旧调用方名称 label。 */
  label?: string | undefined
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'incomplete'
  duration?: string | undefined
  params?: string | undefined
  result?: string | undefined
  error?: string | undefined
  defaultExpanded?: boolean | undefined
}

const STATUS_TEXT: Record<ToolItemProps['status'], string> = {
  running: '正在运行',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  incomplete: '未完成',
}

/**
 * Quiet Tool 行：名称、目标、耗时、状态共享一行，详细输入输出沿细线展开。
 *
 * @param props - 组件属性；字段语义见 `ToolItemProps`。
 */
export function ToolItem(props: ToolItemProps) {
  const {
    name,
    isDelegation = false,
    label,
    status,
    duration,
    params,
    result,
    error,
    defaultExpanded = false,
  } = props
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasDetail = Boolean(params || result || error)
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
      <span className="flex min-w-0 items-baseline gap-1.5">
        <code
          className="block min-w-0 truncate font-mono text-[11.5px] font-medium text-tool-name"
          title={name}
        >
          {name}
        </code>
        {isDelegation && (
          <span className="shrink-0 text-[11px] font-normal text-foreground-faint">委派</span>
        )}
      </span>
      <span className="min-w-0 truncate text-tool-target" title={label}>
        {label}
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
          status === 'success' && 'text-success',
          status === 'failed' && 'text-danger',
          (status === 'running' || status === 'cancelled' || status === 'incomplete') &&
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
        <div
          className={cn(
            'mb-[3px] ml-5 mt-1.5 border-l border-border-strong py-px pl-3 font-mono text-[10.5px] leading-[1.75] text-foreground-muted max-[760px]:ml-[17px]',
            status === 'failed' && 'border-danger/40'
          )}
        >
          {params && (
            <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
              <span className="text-foreground-faint">args</span>
              <span className="truncate" title={params}>
                {params}
              </span>
            </div>
          )}
          {result && (
            <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
              <span className="text-foreground-faint">ret</span>
              <span className="truncate" title={result}>
                {result}
              </span>
            </div>
          )}
          {error && (
            <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
              <span className="text-foreground-faint">err</span>
              <span className="truncate text-danger" title={error}>
                {error}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
