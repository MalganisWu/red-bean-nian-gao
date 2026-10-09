import { useState } from 'react'

import { MarkdownAnswer } from '@/components/MarkdownAnswer'
import { ProcessFold, type ProcessStep } from '@/components/ProcessFold'
import {
  QuestionCard,
  type QuestionCardAnswer,
  type QuestionCardQuestion,
} from '@/components/QuestionCard'

import './ConversationPage.css'

const PROCESS_STATES = [
  ['无过程', '不渲染', '直接显示最终回答'],
  ['执行中', '默认展开', '当前节点轻微呼吸；用户手动折叠后保持选择'],
  ['等待确认', '确认节点常显', '普通输入暂停；问题仍属于当前 Process'],
  ['已完成', '历史默认折叠', '活跃回合保持当前开合；汇总步骤和总耗时'],
  ['失败', '默认展开', '定位首个未处理错误，同时给出文字状态'],
  ['已停止 / 中断', '默认折叠 / 展开', '保留已完成步骤，未返回工具标记“未完成”'],
] as const

const TOOL_STATES = [
  ['等待中', '中性灰', '名称、目标'],
  ['正在运行', '中性灰 + 当前节点呼吸', 'elapsed，不显示伪造完成耗时'],
  ['成功', '成功绿 + “成功”', 'duration、结果摘要'],
  ['失败', '鲜红 + “失败”', '错误摘要、完整输出入口'],
  ['已取消', '中性灰', '取消原因'],
  ['未完成', '中性灰 + “未完成”', '刷新恢复或重试入口'],
] as const

const CONFIRM_LABELS: Record<string, string> = {
  '仅修复已定位的重复写入，并运行测试': '确认：仅修复并测试',
  同时整理订单状态的生命周期: '确认：一并整理',
  '只生成补丁，不运行测试': '确认：只生成补丁',
}

function SpecTable({
  headers,
  rows,
}: {
  headers: readonly string[]
  rows: readonly (readonly string[])[]
}) {
  return (
    <div className="conversation-spec__table-wrap">
      <table className="conversation-spec__table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell) => (
                <td key={cell}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ConversationPage() {
  const [decision, setDecision] = useState<Record<string, QuestionCardAnswer> | undefined>()
  const [refused, setRefused] = useState(false)

  const approvalQuestion = [
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
  const primaryQuestion = approvalQuestion[0]
  if (primaryQuestion === undefined) throw new Error('确认卡示例必须包含问题')
  const primaryOption = primaryQuestion.options?.[0]
  if (primaryOption === undefined) throw new Error('确认卡示例必须包含默认选项')
  const answered: Record<string, QuestionCardAnswer> = {
    scope: { kind: 'option', value: primaryOption },
  }
  const completedSteps: ProcessStep[] = [
    { kind: 'think', content: '先读取同步配置，确认改动范围和现有重试策略。' },
    {
      kind: 'tool',
      tool: {
        name: 'read_file',
        label: 'config/sync.yaml',
        status: 'success',
        duration: '1s',
      },
    },
    {
      kind: 'approval',
      approval: <QuestionCard questions={approvalQuestion} status="answered" answers={answered} />,
    },
    { kind: 'narration', content: '已收到确认，在同一执行过程中继续修改与校验。' },
    {
      kind: 'tool',
      tool: {
        name: 'apply_patch',
        label: 'config/sync.yaml',
        status: 'success',
        duration: '1s',
      },
    },
    {
      kind: 'tool',
      tool: {
        name: 'run_tests',
        label: 'sync policy',
        status: 'success',
        duration: '9s',
      },
    },
  ]

  return (
    <div className="module-container conversation-spec">
      <header className="module-header">
        <div>
          <h2>对话 · Conversation</h2>
          <p>对话、执行过程、工具与确认交互的唯一规范</p>
          <p className="hint">
            Canonical · 视觉与行为均以本页为准，单组件实验页不得覆盖这里的规则。
          </p>
        </div>
      </header>

      <section>
        <h2 className="color-section-title">完整回合 · 一个连续 Process</h2>
        <div className="conversation-demo" aria-label="完整对话回合示例">
          <div className="conversation-demo__user">
            把同步策略改为失败后重试 3 次，但执行前先让我确认。
          </div>

          <div className="conversation-demo__assistant">
            <ProcessFold
              status="completed"
              totalDuration="12s"
              defaultExpanded
              steps={completedSteps}
            />
            <div className="conversation-demo__final">
              <MarkdownAnswer
                content={
                  '已把同步失败后的最大重试次数改为 3 次，重试间隔保持 5 秒。\n\n相关校验已通过，公开接口没有变化。'
                }
              />
            </div>
          </div>
        </div>

        <div className="conversation-running-demo">
          <ProcessFold
            status="running"
            steps={[
              {
                kind: 'narration',
                content: '进行中只有最后一个当前节点轻微呼吸；减弱动效时保持静态灰点。',
                state: 'active',
              },
            ]}
          />
        </div>
      </section>

      <section>
        <h2 className="color-section-title">结构 · 不拆回合</h2>
        <div className="conversation-anatomy">
          <div className="conversation-anatomy__tree" aria-label="Assistant 回合结构">
            <strong>AssistantTurn</strong>
            <span>├─ Process</span>
            <span className="is-child">├─ 进展摘要</span>
            <span className="is-child">├─ 工具</span>
            <span className="is-child">│&nbsp;&nbsp;└─ 子任务（按调用 ID 归属）</span>
            <span className="is-child">└─ 确认节点</span>
            <span>└─ FinalAnswer</span>
          </div>
          <div className="conversation-anatomy__rules">
            <p>
              用户被询问、提交回答、Agent 恢复执行，始终属于<strong>同一个 Process</strong>。
            </p>
            <p>
              Pending 时确认节点必须常显；回答后原地收缩为“原问题 +
              用户答案”，随后时间线继续向下生长。
            </p>
            <p>
              Final 始终在 Process 外裸排；普通段落不增加容器，只有 fenced code block
              使用弱表面、语言标签和独立复制动作。
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="color-section-title">层级 · 靠文字灰度，不靠背景拼贴</h2>
        <div className="conversation-hierarchy">
          <div>
            <span className="conversation-hierarchy__sample is-content">最终回答 / 关键结论</span>
            <strong>Content</strong>
            <p>15px · 1.76 · ink/body · 最高阅读优先级</p>
          </div>
          <div>
            <span className="conversation-hierarchy__sample is-progress">进展叙述与过程摘要</span>
            <strong>Progress</strong>
            <p>13px · secondary/meta · 无类型标签</p>
          </div>
          <div>
            <span className="conversation-hierarchy__sample is-machine">
              <code>read_file</code> · config/sync.yaml
            </span>
            <strong>Machine data</strong>
            <p>12.5px · 仅工具名与原样详情使用 mono</p>
          </div>
        </div>
        <p className="conversation-spec__note">
          Think、进展、工具不显示分类标题。它们通过时间顺序、文字灰度和必要的等宽字段区分，共享一条细线与同一种节点几何。
        </p>
      </section>

      <section>
        <h2 className="color-section-title">状态模型</h2>
        <h3 className="conversation-spec__subhead">Process</h3>
        <SpecTable headers={['状态', '初始折叠', '规则']} rows={PROCESS_STATES} />
        <h3 className="conversation-spec__subhead">Tool</h3>
        <SpecTable headers={['状态', '视觉', '必须提供']} rows={TOOL_STATES} />
        <p className="conversation-spec__note">
          Tool 失败不自动等于 Process 失败；只有回合终态决定 Process
          结果。所有状态必须同时提供文字或图标，不能只靠颜色。
        </p>
      </section>

      <section>
        <h2 className="color-section-title">确认 · 文字动作</h2>
        <div className="conversation-confirm-demo">
          <QuestionCard
            questions={approvalQuestion}
            status={decision ? 'answered' : refused ? 'refused' : 'pending'}
            answers={decision ?? answered}
            confirmLabel={(answer) =>
              answer?.kind === 'option' && answer.value
                ? (CONFIRM_LABELS[answer.value] ?? '确认并继续')
                : '确认并继续'
            }
            onConfirm={(answers) => {
              setDecision(answers)
              setRefused(false)
            }}
            onRefuse={() => setRefused(true)}
          />
        </div>
        <ul className="conversation-spec__list">
          <li>确认动作始终透明背景、无常驻边框，只用豆沙红文字；沿用 canonical 紧凑间距。</li>
          <li>Pending、Submitting、Error、Answered 与 Refused 都必须原位反馈，防止双击提交。</li>
          <li>破坏性风险写进标题和影响说明；失败状态才使用鲜红，不把普通确认误画成危险操作。</li>
        </ul>
      </section>

      <section>
        <h2 className="color-section-title">验收清单</h2>
        <div className="conversation-checklist">
          {[
            'Light / Dark 的字号、间距、折叠行为完全一致',
            '360px 移动端无横向溢出，QuestionCard 与 Composer 几何不漂移',
            'Process 展开与折叠可键盘操作，并暴露 aria-expanded',
            '成功 / 失败同时有状态文字，颜色不是唯一线索',
            '等待确认时节点常显，确认后不生成第二个 Process',
            'prefers-reduced-motion 下停止呼吸与旋转动画',
            '刷新恢复后保留问题、回答、工具终态与折叠选择',
            '独立信息不小于 12px；紧凑摘要与机器详情仅使用 canonical 例外字号',
          ].map((item) => (
            <div key={item}>
              <span aria-hidden="true">✓</span>
              <p>{item}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
