import './RadiusPage.css'

/**
 * 圆角刻度档位表：`[取值, token, 用途]`。
 *
 * 四档依次递进表达「离文档流有多远」——0 贴平（Final / Process / Tool 等文档流内元素）、
 * 6px 适配紧凑列表、8px 统一控件几何、12px 留给真正脱离文档流的浮层；档位少而语义明确，
 * 避免给每块内容都套一层卡片圆角。
 */
const RADII = [
  ['0', '--radius-xs', 'Final 内容、表格、Process 与 Tool'],
  ['6px', '--radius-sm', '菜单项、小型图标控件'],
  ['8px', '--radius-md', '按钮、输入、用户消息、确认选择、代码围栏'],
  ['12px', '--radius-lg', 'Dialog、Popover 等真正浮层'],
] as const

/**
 * 组件到圆角档位的映射：`[组件, 取值, 说明]`。
 *
 * 逐条回答「哪类元素用哪一档、为什么」——把抽象刻度落到具体组件，防止实现时随手挑一个数值；
 * 越靠文档流的组分圆角越小，只有 Dialog / Popover 这类真正浮层才用最大档。
 */
const MAP = [
  ['Final / Process / Tool', '0', '它们是文档流，不是卡片。'],
  ['Fenced code block', '8px', '语义独立的机器内容，带语言标签与复制动作。'],
  ['User message', '8px', '浅灰弱表面，无气泡尾。'],
  ['Button / Input', '8px', '统一控件几何，避免满屏胶囊。'],
  ['Menu item', '6px', '适应紧凑列表，不强调容器。'],
  ['Dialog / Popover', '12px', '只有脱离文档流的浮层使用大圆角。'],
] as const

/** 「圆角」基础页：圆角刻度，以及「哪类元素该用哪一档」的映射表。 */
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
