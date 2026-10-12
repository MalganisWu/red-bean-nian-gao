import './SpacingPage.css'

interface SpacingRow {
  token: string
  px: number
  multiplier: number
  desc: string
  color: 'primary' | 'accent' | 'muted'
}

const SPACING_ROWS: readonly SpacingRow[] = [
  {
    token: '--spacing-1',
    px: 4,
    multiplier: 1,
    desc: '微间距 — icon 与文字的内部微调',
    color: 'primary',
  },
  {
    token: '--spacing-2',
    px: 8,
    multiplier: 2,
    desc: '紧凑间距 — 状态与元信息间隔',
    color: 'primary',
  },
  {
    token: '--spacing-3',
    px: 12,
    multiplier: 3,
    desc: '小间距 — Process 节点与段落间隔',
    color: 'primary',
  },
  {
    token: '--spacing-4',
    px: 16,
    multiplier: 4,
    desc: '基础间距 — 移动端页边距、控件内距',
    color: 'accent',
  },
  { token: '--spacing-5', px: 20, multiplier: 5, desc: '中间距 — 确认区内距', color: 'accent' },
  {
    token: '--spacing-6',
    px: 24,
    multiplier: 6,
    desc: '内容间距 — 桌面确认区与浮层内距',
    color: 'accent',
  },
  {
    token: '--spacing-8',
    px: 32,
    multiplier: 8,
    desc: '区块间距 — 回合最小间隔',
    color: 'muted',
  },
  {
    token: '--spacing-10',
    px: 40,
    multiplier: 10,
    desc: '页面间距 — 线程顶部与大区块间隔',
    color: 'muted',
  },
  {
    token: '--spacing-12',
    px: 48,
    multiplier: 12,
    desc: '大间距 — 大章节留白（谨慎使用）',
    color: 'muted',
  },
]

const USAGE_MAP = [
  { component: 'Desktop reading column', details: '720–760px — 最终回答与完整回合' },
  { component: 'Mobile page gutter', details: '16px — 360px 宽度不横向溢出' },
  { component: 'Assistant turns', details: '32–40px — 独立回合之间' },
  { component: 'Paragraphs', details: '12–14px — 连续正文段落' },
  { component: 'Tool items', details: '10–12px — Process 内相邻事件' },
  {
    component: 'Interactive target',
    details: '导航/表单 ≥ 44px；Process、QuestionCard、Composer 沿用 canonical 紧凑几何',
  },
]

/** 「间距」基础页：间距刻度及其倍数关系。 */
export function SpacingPage() {
  return (
    <div className="module-container">
      <div className="module-header">
        <div>
          <h2>间距 · Spacing</h2>
          <p>4px 基础节奏；优先留白和阅读宽度，不用容器堆叠制造层级</p>
        </div>
      </div>

      <section>
        <h2 className="color-section-title">Base unit · 4px</h2>
        <div className="spacing-base-demo">
          <div className="spacing-base-block" />
          <div className="spacing-base-info">
            <div className="spacing-base-info__title">4px = 1 unit</div>
            <div className="spacing-base-info__desc">
              所有间距值均为 4 的倍数。这确保了视觉节奏的一致性，并简化了 Tailwind 的 p/m/gap
              utility 映射。
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="color-section-title">Scale</h2>
        <div className="spacing-scale">
          {SPACING_ROWS.map((row) => (
            <div key={row.token} className="spacing-row">
              <div className="spacing-row__info">
                <div className="spacing-row__token">{row.token}</div>
                <div className="spacing-row__px">{row.px}px</div>
                <div className="spacing-row__multiplier">{row.multiplier}×base</div>
              </div>
              <div
                className={`spacing-row__bar spacing-row__bar--${row.color}`}
                style={{ width: `${Math.min(row.px * 3, 200)}px` }}
              />
              <div className="spacing-row__desc">{row.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="color-section-title">Usage map</h2>
        <div className="spacing-usage-grid">
          {USAGE_MAP.map((item) => (
            <div key={item.component} className="spacing-usage-card">
              <div className="spacing-usage-card__component">{item.component}</div>
              <div className="spacing-usage-card__details">{item.details}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
