import { cn } from '../lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'

/** 最终回答容器的 Props；`className` 追加在裸排容器之后。 */
export interface MarkdownAnswerProps {
  content: string
  className?: string
}

/**
 * 最终回答保持裸排；Markdown 结构自行建立层级，只有代码围栏拥有独立容器与复制动作。
 *
 * @param props - 组件属性；字段语义见 `MarkdownAnswerProps`。
 */
export function MarkdownAnswer(props: MarkdownAnswerProps) {
  const { content, className } = props
  return (
    <article aria-label="Markdown 回答" className={cn('min-w-0 max-w-full', className)}>
      <MarkdownRenderer content={content} />
    </article>
  )
}
