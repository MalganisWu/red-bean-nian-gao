import { cn } from '../lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'

export interface MarkdownAnswerProps {
  content: string
  className?: string
}

/** 最终回答保持裸排；Markdown 结构自行建立层级，只有代码围栏拥有独立容器与复制动作。 */
export function MarkdownAnswer({ content, className }: MarkdownAnswerProps) {
  return (
    <article aria-label="Markdown 回答" className={cn('min-w-0 max-w-full', className)}>
      <MarkdownRenderer content={content} />
    </article>
  )
}
