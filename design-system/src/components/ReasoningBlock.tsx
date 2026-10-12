/*
 * 复合件 · ReasoningBlock（兼容入口）。
 * 不拥有独立视觉语言：把旧的 reason items 摊平后交给统一的 ProcessFold 渲染，
 * 保留这个导出只为兼容既有调用方，新代码直接用 ProcessFold。
 */
'use client'

import { ProcessFold, type ProcessStep } from './ProcessFold'
import type { ToolItemProps } from './ToolItem'

/** reason 轨道里的一项：一段思考文本，或一次工具调用。 */
export interface ReasonItem {
  itemType: 'step' | 'tool'
  index?: number | undefined
  content?: string | undefined
  tool?: ToolItemProps | undefined
}

/** 兼容入口的 Props；`items` 会被摊平成统一的 Process 步骤。 */
export interface ReasoningBlockProps {
  /** 按时间顺序排列的项；只有带内容的 step 与带 tool 的工具项会被渲染，其余忽略。 */
  items: ReasonItem[]
  /** 是否仍在流式中；true 映射为 running，否则为 completed。 */
  isStreaming?: boolean | undefined
  /** 首次挂载是否展开。 */
  defaultExpanded?: boolean | undefined
}

/** 把一项 reason 记录摊平成 0 或 1 个 Process 步骤；无内容的项直接丢弃。 */
function reasonItemToSteps(item: ReasonItem): ProcessStep[] {
  if (item.itemType === 'tool' && item.tool) return [{ kind: 'tool', tool: item.tool }]
  if (item.itemType === 'step' && item.content) return [{ kind: 'think', content: item.content }]
  return []
}

/**
 * 兼容入口：ReasoningBlock 不再拥有独立视觉语言，而是归入统一 Process 轨道。
 */
export function ReasoningBlock({ items, isStreaming, defaultExpanded }: ReasoningBlockProps) {
  const steps = items.flatMap<ProcessStep>(reasonItemToSteps)

  return (
    <ProcessFold
      steps={steps}
      status={isStreaming ? 'running' : 'completed'}
      defaultExpanded={defaultExpanded}
    />
  )
}
