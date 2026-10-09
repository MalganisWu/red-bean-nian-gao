import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { QuestionCard } from '@/components/retroui/QuestionCard'

const questions = [
  {
    id: 'scope',
    text: '按最小范围修复并运行测试？',
    description: '只修改已定位的问题。',
    options: ['仅修复重复写入并测试', '同时整理订单状态生命周期'],
    select: 'single' as const,
  },
]

const multiQuestions = [
  {
    id: 'scope',
    text: '还有需要补充的执行边界吗？',
    options: ['没有，按当前范围执行', '仅生成补丁'],
    select: 'single' as const,
  },
  {
    id: 'checks',
    text: '需要运行哪些检查？',
    options: ['单元测试', '集成测试'],
    select: 'multi' as const,
  },
]

describe('QuestionCard Quiet Tool 基准', () => {
  it('pending 默认选中第一项、没有旧自定义入口，确认动作可直接使用', () => {
    const onConfirm = vi.fn()
    render(<QuestionCard questions={questions} status="pending" onConfirm={onConfirm} />)

    expect(screen.getByRole('radio', { name: questions[0].options[0] })).toBeChecked()
    expect(screen.queryByRole('button', { name: '自定义回答' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /确认/ }))
    expect(onConfirm).toHaveBeenCalledWith({
      scope: { kind: 'option', value: questions[0].options[0] },
    })

    const card = screen.getByRole('heading', { name: questions[0].text }).closest('[role="group"]')
    expect(card).toHaveClass('rounded-xl', 'border-border-strong', 'bg-background')
    expect(screen.getByRole('button', { name: /确认/ })).toHaveClass(
      'bg-transparent',
      'text-action-confirm'
    )
  })

  it('submitting 锁定选项与动作，避免已发送答案被改写', () => {
    render(<QuestionCard questions={questions} status="pending" submitting />)

    expect(screen.getAllByRole('radio').every((item) => item.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: '正在提交…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '暂不执行' })).toBeDisabled()
  })

  it('disabled 只锁定交互，不冒充正在提交', () => {
    render(<QuestionCard questions={questions} status="pending" disabled />)

    expect(screen.getAllByRole('radio').every((item) => item.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: /确认/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '正在提交…' })).not.toBeInTheDocument()
  })

  it('确认文案可随当前选择变化，与基准交互一致', () => {
    render(
      <QuestionCard
        questions={questions}
        status="pending"
        confirmLabel={(answer) =>
          answer?.kind === 'option' && answer.value === questions[0].options[1]
            ? '确认：一并整理'
            : '确认：仅修复并测试'
        }
      />
    )

    expect(screen.getByRole('button', { name: /确认：仅修复并测试/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: questions[0].options[1] }))
    expect(screen.getByRole('button', { name: /确认：一并整理/ })).toBeInTheDocument()
  })

  it('error 保留回答并可重试；answered 原地显示问题与回答', () => {
    const selected = { scope: { kind: 'option' as const, value: questions[0].options[1] } }
    const { rerender } = render(
      <QuestionCard
        questions={questions}
        status="pending"
        answers={selected}
        error="提交未完成，请重试。"
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('提交未完成，请重试。')
    expect(screen.getByRole('radio', { name: questions[0].options[1] })).toBeChecked()

    rerender(<QuestionCard questions={questions} status="answered" answers={selected} />)
    expect(screen.getByText(questions[0].text)).toBeInTheDocument()
    expect(screen.getByText('你的回答')).toBeInTheDocument()
    expect(screen.getByText(questions[0].options[1])).toBeInTheDocument()
  })

  it('refused 使用中性灰的“暂不执行”，不冒充成功状态', () => {
    render(<QuestionCard questions={questions} status="refused" />)
    const label = screen.getByText('你的选择')
    expect(label).toHaveClass('text-foreground-muted')
    expect(label).not.toHaveClass('text-success')
    expect(screen.getByText('暂不执行')).toBeInTheDocument()
  })

  it('多问题的自定义输入按问题独立，不会泄漏到下一页', () => {
    render(<QuestionCard questions={multiQuestions} status="pending" allowCustomAnswer />)

    fireEvent.click(screen.getByRole('button', { name: '自定义回答' }))
    expect(screen.getByRole('textbox', { name: /还有需要补充/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    expect(screen.queryByRole('textbox', { name: /需要运行哪些检查/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '自定义回答' })).toBeInTheDocument()
  })

  it('多问题支持跳过与多选，最终只提交一份完整答案', () => {
    const onConfirm = vi.fn()
    render(<QuestionCard questions={multiQuestions} status="pending" onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: '跳过此问' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '单元测试' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '集成测试' }))
    fireEvent.click(screen.getByRole('button', { name: '确认并继续' }))

    expect(onConfirm).toHaveBeenCalledWith({
      scope: { kind: 'skip' },
      checks: { kind: 'multi', values: ['单元测试', '集成测试'] },
    })
  })
})
