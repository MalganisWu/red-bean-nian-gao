import { useState } from 'react'
import './ColorPage.css'

/** 单个语义色 token 的展示数据：一套 Light / Dark 取值与用途说明。 */
interface ThemeColor {
  /** 语义 token 名（含别名时用 ` / ` 连接，如 `--foreground / --card-foreground`），是组件唯一可引用的色名。 */
  token: string
  /** Light 主题下的取值；多为 Hex，分类色的软底可能写成对 indicator 的混色描述。 */
  light: string
  /** Dark 主题下的取值；与 Light 同语义、不同明度，保证两套主题都成立。 */
  dark: string
  /** 该 token 的适用场景与边界：写明它表达什么、不该拿来做什么。 */
  use: string
}

/**
 * 表面与边界色组：页面、侧栏、卡片、浮层等承载内容的底色，以及分隔线。
 *
 * Light 用近白到浅灰的层级，Dark 用近黑到深灰的层级；两套取值语义与层级关系一一对应，
 * 组件只引用 token、不必感知当前主题。
 */
const SURFACES: readonly ThemeColor[] = [
  { token: '--background', light: '#FFFFFF', dark: '#0B0B0C', use: '页面、Agent 正文阅读面' },
  { token: '--sidebar', light: '#F6F6F5', dark: '#111112', use: '导航与固定侧栏' },
  { token: '--card', light: '#FFFFFF', dark: '#0B0B0C', use: '卡片与文档阅读面' },
  {
    token: '--muted / --surface-hover',
    light: '#F2F4F5',
    dark: '#1D1D1F',
    use: '用户消息、hover、弱分组',
  },
  { token: '--popover', light: '#FFFFFF', dark: '#1D1D1F', use: '菜单、提示、Toast 浮层' },
  { token: '--input', light: '#FFFFFF', dark: '#0B0B0C', use: '输入控件表面' },
  { token: '--secondary', light: '#F2F4F5', dark: '#1D1D1F', use: '次级控件表面' },
  { token: '--secondary-hover', light: '#ECEBE8', dark: '#262628', use: '次级控件 hover' },
  {
    token: '--border / --hairline',
    light: '#DADCE0',
    dark: '#242426',
    use: '普通分隔线、卡片边界',
  },
  { token: '--border-strong', light: '#C8CBD0', dark: '#363639', use: '需要略强调的结构边界' },
  { token: '--control-border', light: '#8F949C', dark: '#5E5E63', use: '输入、单选等必要控件边界' },
  { token: '--ink', light: '#0B0B0C', dark: '#050506', use: '最高对比墨色与实体控件' },
] as const

/**
 * 文字与工具信息色组：从最高对比的前景到最弱提示的文字，以及过程节点与机器数据。
 *
 * 层级靠灰度而非字号堆叠——标题、正文、辅助、元信息逐级降低对比；Light 与 Dark 各自映射
 * 一套灰度，保证两套主题下都读出相同的层级顺序与可读性下限。
 */
const TEXT_AND_TOOLS: readonly ThemeColor[] = [
  {
    token: '--foreground / --card-foreground',
    light: '#101114',
    dark: '#F3F2EF',
    use: '标题、关键结论与卡片前景',
  },
  {
    token: '--foreground-body / --secondary-foreground',
    light: '#24262A',
    dark: '#D7D4D0',
    use: '正文、用户消息与次级控件前景',
  },
  {
    token: '--foreground-secondary',
    light: '#494C52',
    dark: '#AAA7A3',
    use: '进展叙述、辅助正文',
  },
  {
    token: '--foreground-muted / --muted-foreground',
    light: '#656972',
    dark: '#8C8883',
    use: '时间、计数、状态元信息',
  },
  { token: '--foreground-faint', light: '#656972', dark: '#8C8883', use: '弱提示与图标' },
  {
    token: '--foreground-faintest',
    light: '#70747C',
    dark: '#817D78',
    use: '最低层级但仍承载信息的文字',
  },
  { token: '--process-node', light: '#70747C', dark: '#77736F', use: '已完成的中性时间线节点' },
  {
    token: '--process-node-active',
    light: '#C87972',
    dark: '#C87972',
    use: '唯一进行中的呼吸节点',
  },
  { token: '--process-title', light: '#494C52', dark: '#AAA6A1', use: 'Process 摘要标题' },
  { token: '--process-copy-active', light: '#5D6169', dark: '#B8B4AF', use: '当前进展叙述' },
  { token: '--process-code', light: '#34363B', dark: '#C8C4BF', use: 'Process 内机器数据' },
  { token: '--tool-name', light: '#34363B', dark: '#CFCBC6', use: '工具名称' },
  { token: '--tool-target', light: '#5D6169', dark: '#918D88', use: '工具作用目标' },
  { token: '--tool-duration', light: '#70747C', dark: '#8C8883', use: '工具与过程耗时' },
  { token: '--delegation-name', light: '#34363B', dark: '#B7B3AE', use: '子 Agent 名称' },
  { token: '--question-copy', light: '#494C52', dark: '#A9A5A0', use: '确认影响说明' },
  { token: '--question-option', light: '#5D6169', dark: '#A9A5A0', use: '未选中的确认选项' },
  { token: '--code-inline-bg', light: '#F2F4F5', dark: '#1B1B1D', use: '行内代码背景' },
  { token: '--code-inline-fg', light: '#34363B', dark: '#D9D5D0', use: '行内代码文字' },
] as const

/**
 * 品牌与交互色组：豆沙红的文字、图形、焦点环与高亮底色。
 *
 * 豆沙红只表达品牌、选择与确认，不兼任容器层级或状态色；Light 取较深的豆沙以保对比，
 * Dark 提亮同色相，两套主题都满足对比度要求。
 */
const BRAND_AND_INTERACTION: readonly ThemeColor[] = [
  {
    token: '--brand-text / --primary / --action-confirm / --accent',
    light: '#99413C',
    dark: '#C87972',
    use: '品牌文字、确认动作和兼容主色',
  },
  {
    token: '--brand-indicator / --selection-accent',
    light: '#C87972',
    dark: '#C87972',
    use: '品牌图形、选中控件与活动导航',
  },
  {
    token: '--focus-ring',
    light: '#C87972',
    dark: '#C87972',
    use: '不透明 2px 键盘焦点环；不得用低透明度替代',
  },
  {
    token: '--round-nav-marker',
    light: '#8F949C',
    dark: '#5E5E63',
    use: '未选中的可点击轮次标记；相对阅读面至少 3:1',
  },
  {
    token: '--primary-hover / --action-confirm-hover',
    light: '#793E39',
    dark: '#DF948D',
    use: '豆沙文字 hover / active',
  },
  {
    token: '--primary-soft / --highlight-bg',
    light: '#FAEEEE',
    dark: '#251817',
    use: '品牌柔和背景与高亮底色',
  },
  {
    token: '--primary-foreground / --accent-foreground',
    light: '#FFFFFF',
    dark: '#0B0B0C',
    use: '品牌实心表面的前景色',
  },
  { token: '--highlight-fg', light: '#793E39', dark: '#DF948D', use: '品牌高亮文字' },
] as const

/**
 * 状态反馈色组：成功、失败、警告与中性信息的文字、指示与柔和背景。
 *
 * 颜色只是辅助，每个状态都必须同时给出文字或图标；成功绿、失败鲜红的取值在 Light 与 Dark
 * 下分别调整明度，确保状态在两套主题下同样醒目且可辨。
 */
const STATE: readonly ThemeColor[] = [
  {
    token: '--success-text / --success',
    light: '#0F713D',
    dark: '#55C47B',
    use: '成功文字、已确认文字',
  },
  {
    token: '--success-indicator',
    light: '#2F9E58',
    dark: '#55C47B',
    use: '成功图标与 5–7px 状态节点',
  },
  { token: '--success-bg', light: '#EAF8EF', dark: '#102719', use: '成功柔和背景' },
  {
    token: '--danger-text / --danger / --destructive',
    light: '#B52A36',
    dark: '#FF515E',
    use: '失败、错误与破坏性文字',
  },
  {
    token: '--danger-indicator',
    light: '#E04752',
    dark: '#FF515E',
    use: '失败图标与 5–7px 状态节点',
  },
  { token: '--danger-bg', light: '#FFF0F2', dark: '#2D1115', use: '失败柔和背景' },
  {
    token: '--destructive-foreground',
    light: '#FFFFFF',
    dark: '#0B0B0C',
    use: '破坏性实心表面的前景色',
  },
  { token: '--warning', light: '#99413C', dark: '#C87972', use: '克制的警告文字；当前复用品牌色' },
  { token: '--warning-bg', light: '#FAEEEE', dark: '#251817', use: '警告柔和背景' },
  { token: '--info', light: '#494C52', dark: '#AAA7A3', use: '中性信息文字' },
  { token: '--info-bg', light: '#F2F4F5', dark: '#1D1D1F', use: '中性信息背景' },
] as const

/**
 * 审计分类色组：按「工具 / 子 Agent / 压缩」三种轨迹分类区分的文字、指示与软底。
 *
 * 分类色只在审计轨迹的 chip 与节点上使用，不参与通用语义；每类给 indicator 及同源 soft，
 * Light 用浅底深字、Dark 用 indicator 约 16% 的混色软底，两套主题保持同色相可追溯。
 */
const CATEGORY: readonly ThemeColor[] = [
  {
    token: '--cat-tool-text',
    light: '#3A5C7E',
    dark: '#9DBAD6',
    use: '审计分类「工具」的文字（轨迹 chip 等）',
  },
  {
    token: '--cat-tool-indicator',
    light: '#6E8FAE',
    dark: '#7FA0BF',
    use: '审计分类「工具」的图形指示（节点、细条）',
  },
  {
    token: '--cat-tool-soft',
    light: '#EDF2F7',
    dark: '混色 16%',
    use: '审计分类「工具」的软底；Dark 为 indicator 16% 混合',
  },
  {
    token: '--cat-sub-text',
    light: '#486B53',
    dark: '#A3C2AE',
    use: '审计分类「子 Agent」的文字',
  },
  {
    token: '--cat-sub-indicator',
    light: '#6E967E',
    dark: '#84A48F',
    use: '审计分类「子 Agent」的图形指示',
  },
  {
    token: '--cat-sub-soft',
    light: '#EDF3EE',
    dark: '混色 16%',
    use: '审计分类「子 Agent」的软底；Dark 为 indicator 16% 混合',
  },
  {
    token: '--cat-cmp-text',
    light: '#6E5F49',
    dark: '#C9B795',
    use: '审计分类「压缩」的文字',
  },
  {
    token: '--cat-cmp-indicator',
    light: '#9C8B6E',
    dark: '#A89878',
    use: '审计分类「压缩」的图形指示与虚线描边',
  },
  {
    token: '--cat-cmp-soft',
    light: '#F5F1EA',
    dark: '混色 14%',
    use: '审计分类「压缩」的软底；Dark 为 indicator 14% 混合',
  },
] as const

/**
 * 使用场景对照表：`[颜色家族, 该用在哪, 不要用在哪]`。
 *
 * 逐条给出正反用例，回答「这个颜色到底什么时候用」；写成对照表是为了让评审能直接对照实现，
 * 而不是靠个人理解解释语义色的边界。
 */
const USAGE = [
  [
    '豆沙红',
    '品牌、选择、键盘焦点、确认文字动作、当前活动节点',
    '不用作成功、失败、普通链接或大面积背景',
  ],
  ['成功绿', '工具成功、确认已提交、明确完成状态', '不用作装饰或普通“下一步”动作'],
  ['失败红', '工具失败、提交失败、不可恢复错误', '不用把普通高风险确认直接做成红色实心按钮'],
  ['灰阶', '所有内容层级、边界、禁用、等待中、已取消', '元信息仍须可读；有效信息不使用装饰灰'],
  [
    '色板标签',
    '展示站专用 --swatch-label-overlay：60% 黑色遮罩配白字',
    '不用低于 60% 的遮罩承载浅色色块标签',
  ],
] as const

/**
 * 单个语义色的展示卡：Light / Dark 两个色块可点击复制，下方给出 token、用途与取值。
 *
 * 仅供颜色页内部使用；点击色块把对应取值写入剪贴板，并在 1.2 秒内回显「已复制」。
 *
 * @param props - 组件属性；`color` 为该卡片要展示的语义 token 数据。
 */
function ThemeSwatch(props: { color: ThemeColor }) {
  const { color } = props
  const [copied, setCopied] = useState<'light' | 'dark' | null>(null)

  function copy(value: string, mode: 'light' | 'dark') {
    void navigator.clipboard.writeText(value)
    setCopied(mode)
    window.setTimeout(() => setCopied(null), 1200)
  }

  return (
    <article className="color-token">
      <div className="color-token__preview">
        <button
          type="button"
          style={{ backgroundColor: color.light }}
          aria-label={`复制浅色 ${color.light}`}
          onClick={() => copy(color.light, 'light')}
        >
          <span>{copied === 'light' ? '已复制' : 'Light'}</span>
        </button>
        <button
          type="button"
          style={{ backgroundColor: color.dark }}
          aria-label={`复制深色 ${color.dark}`}
          onClick={() => copy(color.dark, 'dark')}
        >
          <span>{copied === 'dark' ? '已复制' : 'Dark'}</span>
        </button>
      </div>
      <div className="color-token__copy">
        <code>{color.token}</code>
        <p>{color.use}</p>
        <div>
          <span>{color.light}</span>
          <span>{color.dark}</span>
        </div>
      </div>
    </article>
  )
}

/**
 * 一组颜色色块：带标题地渲染若干 `ThemeSwatch`。
 *
 * 把色表按语义分组（表面、文字、品牌、状态、分类），便于在长页面里分区阅读与比对。
 *
 * @param props - 组件属性；`title` 为分组标题，`colors` 为该组内的语义 token 列表。
 */
function ColorGroup(props: { title: string; colors: readonly ThemeColor[] }) {
  const { title, colors } = props
  return (
    <section>
      <h2 className="color-section-title">{title}</h2>
      <div className="color-token-grid">
        {colors.map((color) => (
          <ThemeSwatch key={color.token} color={color} />
        ))}
      </div>
    </section>
  )
}

/** 「颜色」基础页：表面色与语义色的对照表，含明暗两套取值与用途说明。 */
export function ColorPage() {
  return (
    <div className="module-container color-page">
      <header className="module-header">
        <div>
          <h2>颜色 · Color</h2>
          <p>完整列出 Light / Dark 语义颜色：文字、图标、节点、焦点、表面与边框均可追溯</p>
        </div>
      </header>

      <div className="color-page__principle">
        <strong>先选语义，再选颜色。</strong>
        <p>
          组件只能使用 Semantic token；禁止把 Mock 的 Hex
          复制进组件，也禁止为单个页面发明第二套主题。
        </p>
      </div>

      <ColorGroup title="Surface & Border · 表面与边界" colors={SURFACES} />
      <ColorGroup title="Text & Tool · 文字与工具信息" colors={TEXT_AND_TOOLS} />
      <ColorGroup title="Brand & Interaction · 品牌与交互" colors={BRAND_AND_INTERACTION} />
      <ColorGroup title="Status · 状态反馈" colors={STATE} />
      <ColorGroup title="Category · 审计分类色" colors={CATEGORY} />

      <section>
        <h2 className="color-section-title">Usage · 什么场景使用什么颜色</h2>
        <div className="color-usage">
          {USAGE.map(([name, yes, no]) => (
            <div key={name}>
              <strong>{name}</strong>
              <p>{yes}</p>
              <p className="color-usage__no">不要：{no}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="color-section-title">State · 不能只靠颜色</h2>
        <div className="color-state-demo">
          <span className="is-neutral">
            <i aria-hidden="true">●</i> 等待中
          </span>
          <span className="is-success">
            <i aria-hidden="true">✓</i> 成功
          </span>
          <span className="is-danger">
            <i aria-hidden="true">×</i> 失败
          </span>
          <span className="is-confirm">确认并继续 →</span>
        </div>
        <p className="color-page__note">
          成功和失败必须同时出现文字或图标。确认是用户动作，不是成功状态，因此使用豆沙红而不是绿色。
        </p>
      </section>
    </div>
  )
}
