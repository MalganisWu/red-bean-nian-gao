import { ReasoningBlock } from '@/components/ReasoningBlock'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

export function ReasoningBlockPage() {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="推理块 · ReasoningBlock"
        description="不再作为独立视觉模块；进展摘要直接成为 Process 时间线中的普通事件"
        note="Deprecated as a visual container · 保留名称仅用于迁移说明。"
      />

      <p className="spec-callout">
        <strong>新规则：</strong>仅用 13px 无衬线与不同文字灰度，让过程退居最终回答之后。
      </p>

      <section className="spec-section">
        <h3 className="spec-section__title">Collapsed / Expanded</h3>
        <div className="spec-frame">
          <ReasoningBlock
            defaultExpanded
            items={[
              {
                itemType: 'step',
                content: '先检查现有配置与调用位置，确认本次改动不会影响公开接口。',
              },
              { itemType: 'step', content: '已找到重试策略定义，准备修改并补充校验。' },
              { itemType: 'step', content: '相关校验通过，整理最终结果。' },
            ]}
          />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Running</h3>
        <div className="spec-frame">
          <ReasoningBlock
            isStreaming
            items={[
              { itemType: 'step', content: '已读取相关文件并确认改动范围。' },
              { itemType: 'step', content: '正在核对配置边界和失败恢复路径。' },
            ]}
          />
        </div>
        <p className="spec-section__note">
          完成事件使用中性实心点；仅唯一当前事件轻微呼吸。动画关闭时改为静态中性实心点。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Do / Don’t</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>Do</strong>
            <p>短、可验证、描述已经发生或正在发生的动作。</p>
          </div>
          <div>
            <strong>Don’t</strong>
            <p>展示原始思维链、拟人化“AI 正在思考”，或给每条事件加类型标题。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
