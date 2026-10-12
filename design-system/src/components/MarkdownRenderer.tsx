'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '../lib/utils'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'
import './markdown.css'

/** Markdown 渲染器的 Props；`className` 追加在 `markdown-body` 之后。 */
export interface MarkdownRendererProps {
  content: string
  className?: string
}

/**
 * MarkdownRenderer：把内容按 GitHub-Flavored Markdown 解释渲染（含代码块语法高亮）。
 * 这是渲染规则而非内容格式强制规定：内容是 markdown 就渲染，纯文本则原样显示。
 * 展示格式契约：assistant 的最终 content 由 MarkdownAnswer 裸排后经此渲染；
 * fenced code block 才进入带语言标签和复制动作的独立容器；
 * Delegation 内部输出可直接使用本组件，user 输入保持纯文本。
 */
export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock> }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
