import { useState } from 'react'

import { RoundNav, type RoundNavEntry } from '@/components/RoundNav'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

const ROUNDS = [
  ['r1', '计算一组数据', '已返回计算结果', '12s · 1 次工具调用'],
  ['r2', '补充另一组计算', '结果为 363', '3s · 1 次工具调用'],
  ['r3', '查看当前时间', '现在是 21:07，星期二', '2s'],
  ['r4', '汇总第三季度数据', '环比增长 18.3%', '8s · 2 次工具调用'],
  ['r5', '整理为表格', '已整理 4 项结果', '6s'],
] as const

/** 「轮次导航」组件页：多轮次下的悬停摘要与选中态。 */
export function RoundNavPage() {
  const [currentId, setCurrentId] = useState('r2')
  const current = ROUNDS.find((round) => round[0] === currentId) ?? ROUNDS[0]
  const entries: RoundNavEntry[] = ROUNDS.map(([id, question, answer, meta], index) => ({
    id,
    preview: (
      <div className="round-nav-preview">
        <span>第 {index + 1} 轮</span>
        <p className="is-question">{question}</p>
        <p className="is-answer">{answer}</p>
        <p className="is-meta">{meta}</p>
      </div>
    ),
  }))

  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="轮次导航 · RoundNav"
        description="长对话左侧的连续波峰索引：位于历史会话列表与正文之间，指针所在轮次最长"
        note="Real component · 邻近短线按距离平滑递减；悬停与键盘聚焦使用同一波峰。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Desktop left rail</h3>
        <div className="round-nav-specimen">
          <nav className="round-nav-specimen__rail" aria-label="对话轮次">
            <RoundNav entries={entries} currentId={currentId} onSelect={setCurrentId} />
          </nav>
          <div className="round-nav-specimen__preview" aria-live="polite">
            <span>当前轮</span>
            <p className="is-question">{current[1]}</p>
            <p className="is-answer">{current[2]}</p>
            <p className="is-meta">{current[3]}</p>
          </div>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Interaction rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>静默默认态</strong>
            <p>未选轮次保持 10px 灰线；不显示序号、彩色徽章或持续浮层。</p>
          </div>
          <div>
            <strong>连续动态波峰</strong>
            <p>指针中心最大 42px，邻近约 29 / 18 / 10px；落在两轮之间时自然形成双峰。</p>
          </div>
          <div>
            <strong>当前态与键盘</strong>
            <p>静止时当前轮为 21px 豆沙标记；focus 使用与鼠标一致的波峰和摘要。</p>
          </div>
          <div>
            <strong>移动端替代</strong>
            <p>窄屏隐藏边缘索引，不挤占正文横向空间；新增替代导航需先做交互评审。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
