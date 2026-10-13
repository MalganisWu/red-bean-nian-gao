import { cn } from '../lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'

/** 最终回答容器的 Props；`className` 追加在裸排容器之后。 */
export interface MarkdownAnswerProps {
  /** 回答正文，按 GitHub-Flavored Markdown 解释；纯文本会原样显示。 */
  content: string
  /** 追加在最外层容器之后的类名；用于收紧外边距等场景，不用于改写内部排版层级。 */
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
