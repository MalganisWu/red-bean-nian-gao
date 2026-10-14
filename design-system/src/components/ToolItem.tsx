/**
 * 内部件：被 ProcessFold / ReasoningBlock / DelegationBlock 内部使用，
 * 不单独出 showcase 页。见 `skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md`。
 */
'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'

/** 工具行的 Props；`status` 决定配色与图标，`duration` 为已格式化的耗时文案。 */
export interface ToolItemProps {
  /** 工具名（如 `sys_read_file`）；以等宽字体展示，过长时截断并悬浮显示全名。 */
  name: string
  /** 工具调用的唯一标识（`callId`）；仅用于与轨迹记录对齐，不参与渲染。 */
  callId?: string | undefined
  /** 当前工具调用承载一个子 Agent 委派。 */
  isDelegation?: boolean | undefined
  /** 工具作用目标；兼容旧调用方名称 label。 */
  label?: string | undefined
  /** 调用状态：`running`/`cancelled`/`incomplete` 用弱化色，`success` 用成功色，`failed` 用危险色。 */
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'incomplete'
  /** 已格式化好的耗时文案（如 `1.2s`）；不传则不显示耗时列，窄屏下本就隐藏。 */
  duration?: string | undefined
  /** 入参文本（通常是 JSON 串）；与 `result`/`error` 任一存在才允许展开，否则整行不可展开。 */
  params?: string | undefined
  /** 返回结果文本；失败时也可能同时给出 `result` 与 `error`。 */
  result?: string | undefined
  /** 失败原因；存在时展开区以危险色展示，输入输出区的左侧竖线也转为危险色。 */
  error?: string | undefined
  /** 首次挂载是否展开详情；仅当存在 `params`/`result`/`error` 时才有意义，默认 false（收起）。 */
  defaultExpanded?: boolean | undefined
}

/** 状态到中文文案的映射：`status` 是机器可读的枚举，展示统一取这里，避免各处硬编码中文。 */
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
