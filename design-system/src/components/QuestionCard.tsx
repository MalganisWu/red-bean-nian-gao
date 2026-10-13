/*
 * 复合件 · QuestionCard（确认卡）。
 * 一次需要人工确认的交互的可作答表单：单选 / 多选 / 自定义输入 / 跳过四种作答方式，
 * 并覆盖已答与拒答之后的只读形态。
 */
'use client'

import { useId, useState, type ReactNode } from 'react'

import { cn } from '../lib/utils'

/** 卡片里的一个问题；`options` 与 `select` 成对使用，缺省按单选处理。 */
export interface QuestionCardQuestion {
  /** 问题标识；作为作答记录的键，必须在同一次确认内唯一。 */
  id: string
  /** 问题正文，渲染为主标题，允许含反引号内联代码。 */
  text: string
  /** 可选影响说明；旧协议没有该字段时不渲染。 */
  description?: string | undefined
  /** 可选项列表；缺省时不渲染任何选项，只剩自定义输入或跳过入口。 */
  options?: string[] | undefined
  /** 选择方式，缺省按 `single` 单选处理；`multi` 时选项渲染为复选框。 */
  select?: 'single' | 'multi' | undefined
}

/** 单个问题的作答；`value` 用于单选与自定义输入，`values` 用于多选，`skip` 两者都不用。 */
export interface QuestionCardAnswer {
  /** 作答方式，决定 `value` / `values` 哪个字段有效：`skip` 两者都不用。 */
  kind: 'option' | 'multi' | 'custom' | 'skip'
  /** 单选选中的选项值，或自定义输入的文本；仅 `option` / `custom` 时有效。 */
  value?: string | undefined
  /** 多选选中的选项值；仅 `multi` 时有效，空数组等同于未作答。 */
  values?: string[] | undefined
}

/** 确认卡 Props。 */
export interface QuestionCardProps {
  /** 要用户确认的问题列表；调用方应保证非空，空数组渲染出来是一张无内容的卡片。 */
  questions: QuestionCardQuestion[]
  /** 卡片状态；缺省按 `pending` 处理，`answered` / `refused` 时转为只读展示。 */
  status?: 'pending' | 'answered' | 'refused' | undefined
  /** 受控回填的作答；缺省时单选问题会默认选中第一个选项。 */
  answers?: Record<string, QuestionCardAnswer> | undefined
  /** 正在提交：锁定交互并显示提交中态。 */
  submitting?: boolean | undefined
  /** 当前仍有另一条流在收尾时锁定交互，但不显示“正在提交”。 */
  disabled?: boolean | undefined
  /** 提交失败的原因；有值时卡片保持可编辑，以便原地重试。 */
  error?: string | undefined
  /** 只有业务明确允许自由输入时才显示，确认卡默认保持基准的纯选项形态。 */
  allowCustomAnswer?: boolean | undefined
  /** 业务明确知道动作时可给出更直接的确认文案；函数形态可随当前选择变化。 */
  confirmLabel?: string | ((answer: QuestionCardAnswer | undefined) => string) | undefined
  /** 确认回调；入参是按问题 id 索引的完整作答。 */
  onConfirm?: ((answers: Record<string, QuestionCardAnswer>) => void) | undefined
  /** 拒绝回调；不传则整张卡片不渲染拒绝入口。 */
  onRefuse?: (() => void) | undefined
}

/**
 * 计算确认卡的初始作答：在外部传入的作答之上，为未作答的单选问题默认选中第一个选项。
 *
 * 默认选中是为了让单问题的确认卡能一步提交；多选与无选项的问题保持空，等用户显式作答。
 *
 * @param questions - 卡片里的全部问题。
 * @param answers - 外部受控回填的作答；缺省时视为空。
 * @returns 以问题 id 索引的初始作答表。
 */
function initialAnswersFor(
  questions: QuestionCardQuestion[],
  answers?: Record<string, QuestionCardAnswer>
): Record<string, QuestionCardAnswer> {
  const initial = { ...answers }
  for (const question of questions) {
    if (
      !initial[question.id] &&
      (question.select ?? 'single') === 'single' &&
      question.options?.[0]
    ) {
      initial[question.id] = { kind: 'option', value: question.options[0] }
    }
  }
  return initial
}

/**
 * 把一条作答转成人类可读的文案，用于已答态的只读回显。
 *
 * 跳过显式显示「已跳过」而不是留空——留空会让用户分不清是没答还是答了空。
 *
 * @param answer - 待展示的作答；`undefined` 视为未作答。
 * @returns 回显文案，未作答时为空串。
 */
function answerLabel(answer: QuestionCardAnswer | undefined): string {
  if (!answer) return ''
  if (answer.kind === 'skip') return '已跳过'
  if (answer.kind === 'multi') return answer.values?.join('、') ?? ''
  return answer.value ?? ''
}

/**
 * 把问题文案里的反引号片段渲染成内联代码，其余文本原样输出。
 *
 * 与过程轨道同款轻量切分：确认卡文案只需要内联代码，不引入完整 Markdown 引擎。
 *
 * @param content - 待渲染的原始文案。
 * @returns 文本与内联 `code` 元素交错组成的节点数组。
 */
function renderInlineCode(content: string): ReactNode {
  return content.split(/(`[^`\n]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code
        key={`${part}-${index}`}
        className="rounded bg-code-inline-bg px-1 py-px font-mono text-[0.88em] leading-[1.5] text-code-inline-fg"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    )
  )
}

/**
 * 已答或拒答后的只读回显行：展示问题原文与用户的最终选择。
 *
 * 拒答与作答用不同的指示点颜色区分，但都只是状态提示，不提供修改入口——
 * 要改得重新发起一次确认。
 *
 * @param props - 组件属性；`question` 是问题定义，`answer` 是其作答，`refused` 标记是否拒答。
 * @returns 只读的问题与回答回显元素。
 */
function AnsweredQuestion(props: {
  question: QuestionCardQuestion
  answer?: QuestionCardAnswer | undefined
  refused: boolean
}): ReactNode {
  const { question, answer, refused } = props
  return (
    <div className="min-w-0 py-1 first:pt-0 last:pb-0">
      <p className="m-0 min-w-0 font-sans text-[13px] font-[550] leading-[1.55] text-foreground [overflow-wrap:anywhere]">
        {question.text}
      </p>
      <p className="mt-1.5 flex min-w-0 items-center gap-2 font-sans text-[12.5px] leading-[normal] text-foreground-body">
        <span
          aria-hidden="true"
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            refused ? 'bg-foreground-muted' : 'bg-success-indicator'
          )}
        />
        <span className={cn('font-semibold', refused ? 'text-foreground-muted' : 'text-success')}>
          {refused ? '你的选择' : '你的回答'}
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {refused ? '暂不执行' : answerLabel(answer)}
        </span>
      </p>
    </div>
  )
}

/**
 * Process 内的确认节点。它使用独立边框与状态提示；
 * 确认后原地压缩为问题与回答，不生成新的过程或消息。
 *
 * @param props - 组件属性；字段语义见 `QuestionCardProps`。
 */
export function QuestionCard(props: QuestionCardProps) {
  const {
    questions,
    status,
    answers,
    submitting = false,
    disabled = false,
    error,
    allowCustomAnswer = false,
    confirmLabel,
    onConfirm,
    onRefuse,
  } = props
  const groupId = useId()
  const [innerStatus, setInnerStatus] = useState<'pending' | 'answered' | 'refused'>('pending')
  const [draftAnswers, setDraftAnswers] = useState<Record<string, QuestionCardAnswer>>(() =>
    initialAnswersFor(questions, answers)
  )
  const [page, setPage] = useState(0)
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      Object.entries(answers ?? {})
        .filter(([, answer]) => answer.kind === 'custom')
        .map(([questionId]) => [questionId, true])
    )
  )

  const resolvedStatus = status ?? innerStatus
  const resolvedAnswers = resolvedStatus === 'pending' ? draftAnswers : (answers ?? draftAnswers)
  const question = questions[page]

  if (questions.length === 0 || !question) return null

  const setAnswer = (questionId: string, answer?: QuestionCardAnswer) => {
    setDraftAnswers((current) => {
      const next = { ...current }
      if (answer) next[questionId] = answer
      else delete next[questionId]
      return next
    })
  }

  const selectOption = (value: string) => {
    setCustomOpen((current) => ({ ...current, [question.id]: false }))
    if ((question.select ?? 'single') === 'multi') {
      const current = draftAnswers[question.id]
      const values = current?.kind === 'multi' ? [...(current.values ?? [])] : []
      const index = values.indexOf(value)
      if (index >= 0) values.splice(index, 1)
      else values.push(value)
      setAnswer(question.id, values.length > 0 ? { kind: 'multi', values } : undefined)
      return
    }
    setAnswer(question.id, { kind: 'option', value })
  }

  const isSelected = (value: string): boolean => {
    const answer = draftAnswers[question.id]
    if (answer?.kind === 'option') return answer.value === value
    if (answer?.kind === 'multi') return answer.values?.includes(value) ?? false
    return false
  }

  const allAnswered = questions.every((item) => Boolean(draftAnswers[item.id]))
  const currentAnswered = Boolean(draftAnswers[question.id])
  const isLast = page === questions.length - 1
  const currentDraftAnswer = draftAnswers[question.id]
  const selectedLabel = answerLabel(currentDraftAnswer)
  const defaultConfirmLabel =
    questions.length === 1 && selectedLabel && selectedLabel.length <= 18
      ? `确认：${selectedLabel}`
      : '确认并继续'
  const resolvedConfirmLabel =
    typeof confirmLabel === 'function'
      ? confirmLabel(draftAnswers[question.id])
      : (confirmLabel ?? defaultConfirmLabel)

  const handlePrimary = () => {
    if (!currentAnswered || submitting || disabled) return
    if (!isLast) {
      setPage(page + 1)
      return
    }
    if (!allAnswered) return
    if (status === undefined) setInnerStatus('answered')
    onConfirm?.(draftAnswers)
  }

  const handleRefuse = () => {
    if (submitting || disabled) return
    if (status === undefined) setInnerStatus('refused')
    onRefuse?.()
  }

  if (resolvedStatus !== 'pending') {
    return (
      <div
        className="mb-[3px] mt-px min-w-0 max-w-full rounded-xl border border-border-strong bg-background px-3.5 py-3 font-sans"
        role="status"
        aria-live="polite"
      >
        <div className="space-y-3">
          {questions.map((item) => (
            <AnsweredQuestion
              key={item.id}
              question={item}
              answer={resolvedAnswers[item.id]}
              refused={resolvedStatus === 'refused'}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className="mb-[3px] mt-px min-w-0 max-w-full rounded-xl border border-border-strong bg-background px-5 pb-[17px] pt-[19px] font-sans max-[760px]:px-[15px] max-[760px]:pb-[15px] max-[760px]:pt-[17px]"
      role="group"
      aria-labelledby={`${groupId}-title`}
      aria-describedby={question.description ? `${groupId}-description` : undefined}
      aria-busy={submitting}
    >
      <div
        className={cn(
          'flex items-center gap-[7px] text-[10.5px] font-semibold leading-[normal] tracking-[0.02em]',
          error ? 'text-danger-text' : 'text-brand-text'
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-[5px] w-[5px] rounded-full',
            error ? 'bg-danger-indicator' : 'bg-brand-indicator'
          )}
        />
        <span>{error ? '提交失败' : '需要确认'}</span>
        {questions.length > 1 && (
          <span className="ml-auto font-normal text-foreground-muted">
            问题 {page + 1} / {questions.length}
          </span>
        )}
      </div>

      <h3
        id={`${groupId}-title`}
        className="mb-[5px] mt-2 min-w-0 font-sans text-[15px] font-[620] leading-[1.5] tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]"
      >
        {question.text}
      </h3>
      {question.description && (
        <p
          id={`${groupId}-description`}
          className="m-0 min-w-0 text-xs leading-[1.65] text-question-copy [overflow-wrap:anywhere]"
        >
          {renderInlineCode(question.description)}
        </p>
      )}

      <fieldset className="m-0 mt-3.5 grid min-w-0 gap-[7px] border-0 p-0">
        <legend className="sr-only">{question.text}</legend>
        {question.options?.map((option) => (
          <label
            key={option}
            className={cn(
              'flex min-h-[34px] min-w-0 cursor-pointer items-center gap-[9px] text-[12.5px] leading-[1.45] text-question-option transition-colors hover:text-foreground max-[760px]:min-h-[42px]',
              isSelected(option) && 'font-medium text-foreground',
              (submitting || disabled) && 'cursor-not-allowed opacity-60'
            )}
          >
            <input
              type={question.select === 'multi' ? 'checkbox' : 'radio'}
              name={`${groupId}-${question.id}`}
              value={option}
              checked={isSelected(option)}
              disabled={submitting || disabled}
              onChange={() => selectOption(option)}
              className="m-0 h-3.5 w-3.5 shrink-0 accent-selection-accent"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{option}</span>
          </label>
        ))}
      </fieldset>

      {allowCustomAnswer &&
        (customOpen[question.id] || draftAnswers[question.id]?.kind === 'custom' ? (
          <input
            aria-label={`${question.text}——自定义回答`}
            className="mt-2 min-h-11 w-full border-0 border-b border-control-border bg-transparent px-0 py-2 text-[13px] text-foreground outline-none placeholder:text-foreground-faint focus:border-brand-text disabled:cursor-not-allowed disabled:opacity-60"
            placeholder="自定义回答…"
            disabled={submitting || disabled}
            value={currentDraftAnswer?.kind === 'custom' ? (currentDraftAnswer.value ?? '') : ''}
            onChange={(event) => {
              const value = event.target.value
              setAnswer(question.id, value.trim() ? { kind: 'custom', value } : undefined)
            }}
          />
        ) : (
          <button
            type="button"
            disabled={submitting || disabled}
            onClick={() => setCustomOpen((current) => ({ ...current, [question.id]: true }))}
            className="min-h-11 bg-transparent px-0 text-xs text-foreground-muted transition-colors hover:text-foreground-body disabled:cursor-not-allowed disabled:opacity-45"
          >
            自定义回答
          </button>
        ))}

      {error && (
        <p
          role="alert"
          className="mt-2 min-w-0 text-xs leading-normal text-danger [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {submitting && (
        <span role="status" aria-live="polite" className="sr-only">
          正在提交回答
        </span>
      )}

      <div className="mt-[15px] flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 max-[760px]:flex-col max-[760px]:items-start max-[760px]:gap-0.5">
        <button
          type="button"
          disabled={!currentAnswered || submitting || disabled || (isLast && !allAnswered)}
          onClick={handlePrimary}
          className="group inline-flex min-w-0 max-w-full cursor-pointer items-center gap-[5px] bg-transparent px-0 py-1.5 text-[12.5px] font-[650] leading-[normal] text-action-confirm transition-colors hover:text-action-confirm-hover disabled:cursor-not-allowed disabled:text-foreground-faint"
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {submitting ? '正在提交…' : isLast ? resolvedConfirmLabel : '下一题'}
          </span>
          {!submitting && (
            <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          )}
        </button>
        <button
          type="button"
          disabled={submitting || disabled}
          onClick={handleRefuse}
          className="cursor-pointer bg-transparent px-0 py-1.5 text-[12.5px] leading-[normal] text-foreground-muted transition-colors hover:text-foreground-body disabled:cursor-not-allowed disabled:opacity-45"
        >
          暂不执行
        </button>
        {questions.length > 1 && (
          <button
            type="button"
            disabled={submitting || disabled}
            onClick={() => {
              setAnswer(question.id, { kind: 'skip' })
              if (!isLast) setPage(page + 1)
            }}
            className="cursor-pointer bg-transparent px-0 py-1.5 text-[12.5px] leading-[normal] text-foreground-muted transition-colors hover:text-foreground-body disabled:cursor-not-allowed disabled:opacity-45"
          >
            跳过此问
          </button>
        )}
        {page > 0 && (
          <button
            type="button"
            disabled={submitting || disabled}
            onClick={() => setPage(page - 1)}
            className="ml-auto cursor-pointer bg-transparent px-0 py-1.5 text-[12.5px] leading-[normal] text-foreground-muted transition-colors hover:text-foreground-body disabled:cursor-not-allowed disabled:opacity-45 max-[760px]:ml-0"
          >
            上一题
          </button>
        )}
      </div>
    </div>
  )
}
