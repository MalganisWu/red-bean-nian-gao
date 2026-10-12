'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'
import { ToolItem, type ToolItemProps } from './ToolItem'

/** 过程整体的状态；决定折叠标题的文案与配色。 */
export type ProcessStatus = 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled'
/** 单个步骤的完成度：已完成 / 进行中 / 等待中。 */
export type ProcessStepState = 'complete' | 'active' | 'waiting'

/** 过程轨道里的一步；`kind` 标明步骤类型，对应的载荷字段按需填入，其余忽略。 */
export interface ProcessStep {
  kind: 'think' | 'narration' | 'tool' | 'sub_agent' | 'approval'
  content?: string | undefined
  tool?: ToolItemProps | undefined
  subAgent?: ReactNode | undefined
  approval?: ReactNode | undefined
  state?: ProcessStepState | undefined
  /** 兼容旧调用方；true 等同于 state="active"。 */
  active?: boolean | undefined
}

/** 过程折叠轨道的 Props。 */
export interface ProcessFoldProps {
  /** 按时间顺序排好的步骤；空数组会渲染成空轨道，调用方应自行决定是否渲染本组件。 */
  steps: ProcessStep[]
  /** 过程整体状态；缺省时按 `isStreaming` 推导。 */
  status?: ProcessStatus | undefined
  /** 兼容旧调用方；未显式传 status 时映射为 running / completed。 */
  isStreaming?: boolean | undefined
  /** 过程总耗时的展示文案（已格式化的字符串）；缺省则不显示。 */
  totalDuration?: string | undefined
  /** 首次挂载是否展开；后续开合由用户操作主导，不受此属性影响。 */
  defaultExpanded?: boolean | undefined
}

const STATUS_LABEL: Record<ProcessStatus, string> = {
  running: '正在执行',
  awaiting: '等待确认',
  completed: '过程已完成',
  failed: '执行失败',
  cancelled: '已停止',
}

function isPendingApproval(step: ProcessStep): boolean {
  return step.kind === 'approval' && (step.state === 'waiting' || step.active === true)
}

function renderProcessCopy(content: string): ReactNode {
  return content.split(/(`[^`\n]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code
        key={`${part}-${index}`}
        className="font-mono text-[0.92em] leading-[1.5] text-process-code"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    )
  )
}

/**
 * 一轮回复的单一过程轨道。思考、进展、工具、子任务和确认只按时间排序，
 * 不显示类型标签或步骤编号。等待确认时，即使收起历史步骤，确认节点仍常显。
 */
export function ProcessFold({
  steps,
  status,
  isStreaming,
  totalDuration,
  defaultExpanded,
}: ProcessFoldProps) {
  const resolvedStatus = status ?? (isStreaming ? 'running' : 'completed')
  // 只在挂载时根据初始状态决定开合。awaiting/running 转为 completed 时保留
  // 当前展开状态，避免确认回答和刚追加的续跑步骤在 DONE 瞬间被自动收起。
  const [expanded, setExpanded] = useState(
    () =>
      defaultExpanded ??
      (resolvedStatus === 'running' || resolvedStatus === 'awaiting' || resolvedStatus === 'failed')
  )
  const pendingApproval = steps.some(isPendingApproval)
  const completedCount = steps.filter(
    (step) => step.state !== 'active' && step.state !== 'waiting' && step.active !== true
  ).length
  const summary =
    resolvedStatus === 'awaiting'
      ? `${completedCount} 步已完成`
      : `${steps.length} 步${totalDuration ? ` · ${totalDuration}` : ''}`

  if (steps.length === 0) return null

  return (
    <div
      role="group"
      className="my-0 mb-5 min-w-0"
      aria-label={`${STATUS_LABEL[resolvedStatus]}，${summary}`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className={cn(
          'group flex w-fit max-w-full cursor-pointer items-center gap-2 bg-transparent py-[5px] pr-0.5 text-left font-sans text-xs leading-[1.4] text-foreground-muted transition-colors',
          'hover:text-foreground',
          resolvedStatus === 'failed' && 'text-danger'
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-foreground-faint transition-transform duration-150',
            expanded && 'rotate-90'
          )}
          strokeWidth={1.4}
        />
        <span
          aria-hidden="true"
          className={cn(
            'h-[5px] w-[5px] shrink-0 rounded-full',
            resolvedStatus === 'completed' && 'bg-success-indicator',
            (resolvedStatus === 'running' || resolvedStatus === 'awaiting') &&
              'bg-process-node-active motion-safe:animate-[process-breathe_1.8s_ease-in-out_infinite]',
            resolvedStatus === 'failed' && 'bg-danger-indicator',
            resolvedStatus === 'cancelled' && 'bg-foreground-faint'
          )}
        />
        <span
          role="status"
          aria-live="polite"
          className={cn(
            'font-[520] text-process-title transition-colors group-hover:text-foreground',
            resolvedStatus === 'failed' && 'text-danger group-hover:text-danger'
          )}
        >
          {STATUS_LABEL[resolvedStatus]}
        </span>
        <span aria-hidden="true" className="text-border-strong">
          ·
        </span>
        <span className="min-w-0 truncate text-foreground-muted">{summary}</span>
      </button>

      {(expanded || pendingApproval) && (
        <ol className="mb-0.5 ml-[5px] mt-[7px] min-w-0 max-w-full list-none py-0.5 pl-0">
          {steps.map((step, index) => {
            const visible = expanded || isPendingApproval(step)
            const active =
              step.state === 'active' || step.state === 'waiting' || step.active === true

            return (
              <li
                key={index}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'relative min-h-[30px] min-w-0 max-w-full py-[5px] pb-[15px] pl-[27px] last:pb-[5px]',
                  !visible && 'hidden'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute left-0 top-3 z-[1] h-[7px] w-[7px] rounded-full bg-process-node',
                    active &&
                      'bg-process-node-active motion-safe:animate-[process-breathe_1.8s_ease-in-out_infinite]'
                  )}
                />
                {index < steps.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-[-12px] left-[3px] top-5 w-px bg-border-strong"
                  />
                )}

                {(step.kind === 'think' || step.kind === 'narration') && (
                  <p
                    className={cn(
                      'm-0 min-w-0 font-sans text-[13px] font-normal leading-[1.7] text-foreground-secondary [overflow-wrap:anywhere] max-[760px]:text-[12.5px]',
                      active && 'text-process-copy-active'
                    )}
                  >
                    {renderProcessCopy(step.content ?? '')}
                  </p>
                )}
                {step.kind === 'tool' && step.tool && (
                  <>
                    <ToolItem {...step.tool} isDelegation={Boolean(step.subAgent)} />
                    {step.subAgent && (
                      <div
                        role="group"
                        aria-label={`${step.tool.name} 的委派任务`}
                        className="ml-5 mt-1 min-w-0 max-[760px]:ml-[17px]"
                      >
                        {step.subAgent}
                      </div>
                    )}
                  </>
                )}
                {step.kind === 'sub_agent' && step.subAgent}
                {step.kind === 'approval' && step.approval}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
