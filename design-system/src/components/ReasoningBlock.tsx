'use client'

import { ProcessFold, type ProcessStep } from './ProcessFold'
import type { ToolItemProps } from './ToolItem'

export interface ReasonItem {
  itemType: 'step' | 'tool'
  index?: number | undefined
  content?: string | undefined
  tool?: ToolItemProps | undefined
}

export interface ReasoningBlockProps {
  items: ReasonItem[]
  isStreaming?: boolean | undefined
  defaultExpanded?: boolean | undefined
}

/**
 * 兼容入口：ReasoningBlock 不再拥有独立视觉语言，而是归入统一 Process 轨道。
 */
export function ReasoningBlock({ items, isStreaming, defaultExpanded }: ReasoningBlockProps) {
  const steps = items.flatMap<ProcessStep>((item): ProcessStep[] => {
    if (item.itemType === 'tool' && item.tool) return [{ kind: 'tool', tool: item.tool }]
    if (item.itemType === 'step' && item.content) return [{ kind: 'think', content: item.content }]
    return []
  })

  return (
    <ProcessFold
      steps={steps}
      status={isStreaming ? 'running' : 'completed'}
      defaultExpanded={defaultExpanded}
    />
  )
}
