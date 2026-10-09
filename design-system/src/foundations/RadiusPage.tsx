import './RadiusPage.css'

const RADII = [
  ['0', '--radius-xs', 'Final 内容、表格、Process 与 Tool'],
  ['6px', '--radius-sm', '菜单项、小型图标控件'],
  ['8px', '--radius-md', '按钮、输入、用户消息、确认选择、代码围栏'],
  ['12px', '--radius-lg', 'Dialog、Popover 等真正浮层'],
] as const

const MAP = [
  ['Final / Process / Tool', '0', '它们是文档流，不是卡片。'],
  ['Fenced code block', '8px', '语义独立的机器内容，带语言标签与复制动作。'],
  ['User message', '8px', '浅灰弱表面，无气泡尾。'],
  ['Button / Input', '8px', '统一控件几何，避免满屏胶囊。'],
  ['Menu item', '6px', '适应紧凑列表，不强调容器。'],
  ['Dialog / Popover', '12px', '只有脱离文档流的浮层使用大圆角。'],
] as const

export function RadiusPage() {
  return (
    <div className="module-container radius-page">
      <header className="module-header">
        <div>
          <h2>圆角 · Radius</h2>
          <p>圆角表达控件边界，不负责让每块内容都像卡片</p>
        </div>
      </header>

      <section>
        <h2 className="color-section-title">Scale · 0 / 6 / 8 / 12</h2>
        <div className="radius-scale">
          {RADII.map(([value, token, use]) => (
            <article key={token}>
              <div className="radius-scale__shape" style={{ borderRadius: value }} />
              <strong>{value}</strong>
              <code>{token}</code>
              <p>{use}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="color-section-title">Component map</h2>
        <div className="radius-map">
          {MAP.map(([component, radius, note]) => (
            <div key={component}>
              <strong>{component}</strong>
              <code>{radius}</code>
              <p>{note}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
