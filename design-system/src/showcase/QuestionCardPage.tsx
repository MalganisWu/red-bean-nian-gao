import { useState } from 'react'

import { ProcessFold, type ProcessStep } from '@/components/ProcessFold'
import {
  QuestionCard,
  type QuestionCardAnswer,
  type QuestionCardQuestion,
} from '@/components/QuestionCard'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

/**
 * 确认卡问题夹具：只含一个「scope」单选问题，三个选项分别代表完整修复、
 * 一并整理与只出补丁，用来演示单选作答的主流程。
 */
const QUESTIONS = [
  {
    id: 'scope',
    text: '按最小范围修复并运行测试？',
    description: '将修改 `settle.ts` 并运行测试；不会调整公开接口，也不会提交代码。',
    options: [
      '仅修复已定位的重复写入，并运行测试',
      '同时整理订单状态的生命周期',
      '只生成补丁，不运行测试',
    ],
    select: 'single',
  },
] satisfies QuestionCardQuestion[]

/**
 * 首个问题的引用；下游的选项常量与默认作答都以它为准。
 *
 * 下面的断言不是业务逻辑，只是让「示例必须至少有一个问题与三个选项」
 * 在夹具被改坏时立刻失败，而不是渲染出空卡片。
 */
const PRIMARY_QUESTION = QUESTIONS[0]
if (PRIMARY_QUESTION === undefined) throw new Error('确认卡示例必须包含问题')
const [PRIMARY_OPTION, SECONDARY_OPTION, PATCH_ONLY_OPTION] = PRIMARY_QUESTION.options ?? []
if (
  PRIMARY_OPTION === undefined ||
  SECONDARY_OPTION === undefined ||
  PATCH_ONLY_OPTION === undefined
) {
  throw new Error('确认卡示例必须包含三个选项')
}

/**
 * 静态展示用的默认作答：把「scope」题选中第一个选项。
 *
 * 供已作答 / 提交中 / 错误等只读形态复用，避免每张卡片各写一份答案。
 */
const DEFAULT_ANSWERS: Record<string, QuestionCardAnswer> = {
  scope: { kind: 'option', value: PRIMARY_OPTION },
}

/**
 * 选项值到确认按钮文案的映射：按钮回显「将要执行什么」，而不是笼统的「确认」。
 *
 * 未命中映射时调用方回退到通用文案，因此这里可以只覆盖已知的三个选项。
 */
const CONFIRM_LABELS: Record<string, string> = {
  [PRIMARY_OPTION]: '确认：仅修复并测试',
  [SECONDARY_OPTION]: '确认：一并整理',
  [PATCH_ONLY_OPTION]: '确认：只生成补丁',
}

/** 「确认卡」组件页：单选 / 多选 / 自定义 / 跳过四种作答形态。 */
export function QuestionCardPage() {
  const [resolution, setResolution] = useState<'pending' | 'answered' | 'refused'>('pending')
  const [submittedAnswers, setSubmittedAnswers] = useState<
    Record<string, QuestionCardAnswer> | undefined
  >()
  const continued = resolution !== 'pending'

  /** 记录确认卡的作答，并把过程推进到已作答。 */
  function handleConfirm(nextAnswers: Record<string, QuestionCardAnswer>): void {
    setSubmittedAnswers(nextAnswers)
    setResolution('answered')
  }

  const steps: ProcessStep[] = [
    { kind: 'think', content: '范围已经明确。准备把状态读写收口到既有事务边界。' },
    {
      kind: 'narration',
      content: '修改会涉及 src/order/settle.ts 的状态读写和事务顺序。',
    },
    {
      kind: 'approval',
      state: continued ? 'complete' : 'waiting',
      approval: (
        <QuestionCard
          questions={QUESTIONS}
          status={resolution}
          answers={continued ? submittedAnswers : undefined}
          confirmLabel={(answer) =>
            answer?.kind === 'option' && answer.value
              ? (CONFIRM_LABELS[answer.value] ?? '确认并继续')
              : '确认并继续'
          }
          onConfirm={handleConfirm}
          onRefuse={() => setResolution('refused')}
        />
      ),
    },
  ]

  if (continued) {
    steps.push(
      { kind: 'narration', content: '已收到回答，在原执行过程中继续修改。' },
      {
        kind: 'tool',
        tool: {
          name: 'apply_patch',
          label: 'src/order/settle.ts',
          status: 'success',
          duration: '1s',
          result: '修改 14 行，公开接口未变化',
        },
      }
    )
  }

  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="确认卡 · QuestionCard"
        description="确认是当前 Process 中一个需要用户输入的节点"
        note="Real component · pending / answered / refused / submit error"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Pending → Answered → Continue</h3>
        <div className="spec-frame">
          <ProcessFold
            status={continued ? 'completed' : 'awaiting'}
            totalDuration={continued ? '5s' : undefined}
            defaultExpanded
            steps={steps}
          />
          {resolution === 'answered' && (
            <p className="approval-final">已完成修复并通过测试，公开接口没有变化。</p>
          )}
          {resolution === 'refused' && (
            <p className="approval-final">已按你的选择停止，本轮没有修改代码。</p>
          )}
        </div>
        <p className="spec-section__note">
          选择答案并确认后，问题原地收缩成“原问题 + 你的回答”，后续事件继续出现在同一条时间线上。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Answered / Refused / Submitting / Locked / Error</h3>
        <div className="approval-state-grid">
          <QuestionCard questions={QUESTIONS} status="answered" answers={DEFAULT_ANSWERS} />
          <QuestionCard questions={QUESTIONS} status="refused" />
          <QuestionCard
            questions={QUESTIONS}
            status="pending"
            answers={DEFAULT_ANSWERS}
            submitting
          />
          <QuestionCard questions={QUESTIONS} status="pending" answers={DEFAULT_ANSWERS} disabled />
          <QuestionCard
            questions={QUESTIONS}
            status="pending"
            answers={DEFAULT_ANSWERS}
            error="提交未完成，请重试。"
          />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Custom / Multi-question capability</h3>
        <div className="spec-frame">
          <QuestionCard
            status="pending"
            allowCustomAnswer
            answers={{ detail: { kind: 'custom', value: '先只检查 order 模块。' } }}
            questions={[
              {
                id: 'detail',
                text: '还有需要补充的执行边界吗？',
                options: ['没有，按当前范围执行', '仅生成补丁'],
                select: 'single',
              },
              {
                id: 'checks',
                text: '需要运行哪些检查？',
                options: ['单元测试', '集成测试', '构建检查'],
                select: 'multi',
              },
            ]}
          />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Long content / 360px safety</h3>
        <div className="spec-frame">
          <div className="w-full max-w-[360px]">
            <QuestionCard
              status="pending"
              questions={[
                {
                  id: 'long-target',
                  text: '确认这个包含长路径的执行目标？',
                  options: [
                    'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    '暂不处理',
                  ],
                  select: 'single',
                },
              ]}
            />
          </div>
        </div>
        <p className="spec-section__note">
          URL、命令和连续字符必须在卡片内部换行，不得制造横向滚动。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>确认动作</strong>
            <p>透明背景、无常驻边框，仅豆沙红文字；使用 canonical 的紧凑纵向内边距。</p>
          </div>
          <div>
            <strong>状态颜色</strong>
            <p>已确认用绿色，提交失败用鲜红；普通高风险确认仍用豆沙红。</p>
          </div>
          <div>
            <strong>Pending 可见</strong>
            <p>Process 即使收起，等待回答的确认节点也不能被隐藏。</p>
          </div>
          <div>
            <strong>防重复提交</strong>
            <p>Submitting 原位保留选择、显示进度并禁止重复点击。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
