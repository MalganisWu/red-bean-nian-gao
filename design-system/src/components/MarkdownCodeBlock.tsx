// 内部件：由 MarkdownRenderer 为 fenced code block 提供语言标签与复制动作，
// 不单独对前端承诺 API。见 `skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md`。
'use client'

import { Children, isValidElement, type ReactNode, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '../lib/utils'

/** 代码块容器的 Props；`children` 是 fenced code block 渲染出的 code 元素。 */
interface MarkdownCodeBlockProps {
  /** 上一个渲染层传入的节点，正常情形是 `<pre>` 里的 `code` 元素；缺失时按纯文本处理。 */
  children?: ReactNode
}

/** 从 children 里取 code 元素时用的宽松属性视图；只读 `className` 与 `children` 两项。 */
interface CodeElementProps {
  /** code 元素上的类名，其中的 `language-*` 片段用来推断语言标签。 */
  className?: string
  /** code 元素的子节点，累积成待复制的源码文本。 */
  children?: ReactNode
}

/** 复制动作的瞬时状态；`copied` / `failed` 只做短暂反馈，随后自动回到 `idle`。 */
type CopyState = 'idle' | 'copied' | 'failed'

/** 语言标识到展示名的映射；命中不了时退回原始标识，纯文本类的各种别名统一显示为「纯文本」。 */
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

/**
 * 递归取出 React 节点里的纯文本，用于拼出待复制的源码。
 *
 * 只认字符串、数字与元素节点，其余（函数、`null` 等）一律贡献空串——把
 * `[object Object]` 复制进剪贴板比复制失败更糟，所以宁可少取也不乱取。
 *
 * @param node - 任意 React 节点，通常是 code 元素的 children。
 * @returns 节点里累积出的纯文本。
 */
function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (isValidElement<CodeElementProps>(node)) return textContent(node.props.children)
  return ''
}

/**
 * 剪贴板 API 不可用时的兜底复制：借一个屏幕外的只读 textarea 走 `execCommand('copy')`。
 *
 * 这是旧环境（非安全上下文等）的最后手段，不保证成功，因此把命令结果原样返回给调用方决定反馈。
 *
 * @param content - 要写入剪贴板的源码文本。
 * @returns 复制命令是否报告成功。
 */
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

/**
 * 从 children 里挑出第一个元素节点，作为承载源码与语言信息的 `code` 元素。
 *
 * @param children - 代码块容器的 children，可能混有空白文本节点。
 */
function codeElementOf(children: ReactNode) {
  return Children.toArray(children).find((child) => isValidElement<CodeElementProps>(child))
}

/**
 * 从 code 元素的 `className` 里解析 `language-*` 片段，得出展示用的语言标签。
 *
 * 识别不出语言时按「纯文本」展示而非留空——留空会让头部标签位显得像渲染坏了；
 * 反之若标识已知但没进映射表，则原样显示标识，方便对照补表。
 *
 * @param className - code 元素的完整类名，可能缺省或含多个类。
 * @returns 展示用的语言标签，未识别时返回「纯文本」。
 */
function languageLabel(className?: string): string {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase()
  if (!language) return '纯文本'
  return LANGUAGE_LABELS[language] ?? language
}

/**
 * 代码块容器；从 children 里提取语言标签并提供复制动作，复制结果用短暂状态反馈。
 *
 * @param props - 组件属性；`children` 为 fenced code block 渲染出的 code 元素，
 *   语言标签由其 `className` 的 `language-*` 推出，识别不出时退回「纯文本」。
 */
export function MarkdownCodeBlock(props: MarkdownCodeBlockProps) {
  const { children } = props
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
        throw new Error('复制命令失败')
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
