/**
 * 内部件：由 MarkdownRenderer 为 fenced code block 提供语言标签与复制动作，
 * 不单独对前端承诺 API。见 design-system/AGENTS.md「组件入册规则」。
 */
'use client'

import { Children, isValidElement, type ReactNode, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '../lib/utils'

interface MarkdownCodeBlockProps {
  children?: ReactNode
}

interface CodeElementProps {
  className?: string
  children?: ReactNode
}

type CopyState = 'idle' | 'copied' | 'failed'

const LANGUAGE_LABELS: Record<string, string> = {
  text: '纯文本',
  plaintext: '纯文本',
  txt: '纯文本',
  markdown: 'Markdown',
  md: 'Markdown',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  sh: 'Shell',
  bash: 'Shell',
  shell: 'Shell',
  zsh: 'Shell',
  go: 'Go',
  py: 'Python',
  python: 'Python',
  css: 'CSS',
  html: 'HTML',
  xml: 'XML',
  sql: 'SQL',
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (isValidElement<CodeElementProps>(node)) return textContent(node.props.children)
  return ''
}

function fallbackCopyText(content: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
}

function codeElementOf(children: ReactNode) {
  return Children.toArray(children).find((child) => isValidElement<CodeElementProps>(child))
}

function languageLabel(className?: string): string {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase()
  if (!language) return '纯文本'
  return LANGUAGE_LABELS[language] ?? language
}

export function MarkdownCodeBlock({ children }: MarkdownCodeBlockProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const codeElement = codeElementOf(children)
  const label = languageLabel(
    isValidElement<CodeElementProps>(codeElement) ? codeElement.props.className : undefined
  )
  const code = textContent(codeElement ?? children).replace(/\n$/, '')

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  async function copyCode(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code)
      } else if (!fallbackCopyText(code)) {
        throw new Error('copy command failed')
      }
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopyState('idle'), 1500)
  }

  const copied = copyState === 'copied'
  const failed = copyState === 'failed'
  const buttonLabel = copied ? '已复制' : failed ? '复制失败' : '复制'
  const ariaLabel = copied
    ? `${label}代码已复制`
    : failed
      ? `${label}代码复制失败，请重试`
      : `复制${label}代码`

  return (
    <section aria-label={`${label}代码块`} className="markdown-code-block">
      <div className="markdown-code-block__header">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => {
            void copyCode()
          }}
          aria-label={ariaLabel}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-sm bg-transparent px-1.5 py-1 font-sans text-xs leading-none text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
            copied && 'text-success hover:text-success',
            failed && 'text-danger hover:text-danger'
          )}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-[13px] w-[13px]" strokeWidth={1.6} />
          ) : (
            <Copy aria-hidden="true" className="h-[13px] w-[13px]" strokeWidth={1.4} />
          )}
          <span aria-live="polite">{buttonLabel}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </section>
  )
}
