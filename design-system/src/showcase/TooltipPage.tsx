import { Info } from 'lucide-react'

import { Tooltip } from '@/components/Tooltip'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

/** 「提示」组件页：中性高对比样式与可访问性要求。 */
export function TooltipPage(): React.ReactElement {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="提示 · Tooltip"
        description="只保留一种中性高对比样式，约 400ms 后出现。"
        note="状态信息不藏在 Tooltip 中；图标触发器必须拥有可访问名称。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Neutral tooltip</h3>
        <div className="flex min-h-36 items-center gap-4 border-y border-border-strong py-5">
          <Tooltip.Provider delay={400}>
            <Tooltip defaultOpen>
              <Tooltip.Trigger
                aria-label="测试说明"
                className="grid h-11 w-11 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-foreground-muted hover:bg-surface-hover hover:text-foreground sm:h-9 sm:w-9"
              >
                <Info aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} />
              </Tooltip.Trigger>
              <Tooltip.Content>仅运行一次，不改变定时计划</Tooltip.Content>
            </Tooltip>
          </Tooltip.Provider>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>Use</strong>
            <p>解释无文字图标或补充非关键细节。</p>
          </div>
          <div>
            <strong>Avoid</strong>
            <p>不要把错误、成功或必须阅读的说明仅放在 Tooltip 内。</p>
          </div>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Compatibility aliases</h3>
        <div className="flex flex-wrap items-center gap-3 border-y border-border-strong py-5">
          <Tooltip.Provider delay={400}>
            <Tooltip>
              <Tooltip.Trigger className="min-h-11 cursor-pointer rounded-md border border-border-strong bg-background px-3 text-xs text-foreground-body sm:min-h-9">
                primary alias
              </Tooltip.Trigger>
              <Tooltip.Content variant="primary">沿用同一中性样式</Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <Tooltip.Trigger className="min-h-11 cursor-pointer rounded-md border border-border-strong bg-background px-3 text-xs text-foreground-body sm:min-h-9">
                solid alias
              </Tooltip.Trigger>
              <Tooltip.Content variant="solid">沿用同一中性样式</Tooltip.Content>
            </Tooltip>
          </Tooltip.Provider>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-foreground-faint">
          旧 variant 名称仅用于 API 兼容，视觉统一为中性高对比提示层。
        </p>
      </section>
    </div>
  )
}
