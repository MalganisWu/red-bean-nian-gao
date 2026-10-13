import { downloadDesignPhilosophyMarkdown } from './philosophyMarkdown'
import './PhilosophyPage.css'

/**
 * 四条设计原则：`{ title, body }`，按优先级排序。
 *
 * 内容先于界面、灰阶负责层级、颜色只说一件事、过程连续且可验证；后续章节的图例与可下载文档
 * 都由这几条派生，出现分歧时以本数组为准。
 */
const PRINCIPLES = [
  {
    title: '内容先于界面',
    body: '最终回答拥有最高对比度。过程信息退后，但不牺牲可读性；界面不通过卡片数量证明复杂度。',
  },
  {
    title: '灰阶负责层级',
    body: '纯白、近黑和少量暖灰完成结构。不同深度的文字灰度区分正文、进展、机器信息和元信息。',
  },
  {
    title: '颜色只说一件事',
    body: '豆沙红表示品牌、选择与确认；绿色只表示成功；鲜红只表示失败或错误。颜色不兼任容器层级。',
  },
  {
    title: '过程连续且可验证',
    body: 'Process 是按时间排序的事件流。确认问答属于原 Process，回答后原地收缩并继续，不产生第二段过程。',
  },
] as const

/**
 * 短提示式的唯一口径表：`[标签, 规则]`。
 *
 * 覆盖 Theme / Type / Color / Surface / Process / Approval 六个维度，每条给一句可执行约束，
 * 供设计与实现快速对齐；它不是穷举规范，只承担「不跑偏」的最小共识。
 */
const RULES = [
  ['Theme', 'Light 默认；用户切换后持久化。Dark 与 Light 只替换语义 token。'],
  ['Type', '无衬线正体为默认；等宽只给工具名、命令、路径、参数与结果；字重仅 400 / 500 / 600。'],
  ['Color', '白 / 近黑 / 灰阶 + 豆沙红；成功绿、失败鲜红；状态同时提供文字或图标。'],
  ['Surface', 'Final、Process 与 Tool 保持裸排；只有代码围栏等语义独立内容使用弱表面。'],
  ['Process', '统一时间线，不显示 Think / Tool / Content 分类标签；完成实心点，进行中轻微呼吸。'],
  ['Approval', '确认按钮透明无填充，仅文字豆沙红；确认后在原节点保留问题与回答。'],
] as const

/** 「设计理念」页：原则条目，以及可下载的哲学文档正文。 */
export function PhilosophyPage() {
  return (
    <div className="module-container philosophy-page">
      <header className="module-header philosophy-page__header">
        <div>
          <h2>设计理念 · Philosophy</h2>
          <p>Quiet Tool UI · 白、黑、灰阶与一小点豆沙红</p>
          <p className="hint">Canonical</p>
        </div>
        <button
          type="button"
          className="philosophy-page__download"
          onClick={downloadDesignPhilosophyMarkdown}
        >
          下载完整规范 ↓
        </button>
      </header>

      <section className="philosophy-intro">
        <p>
          red-bean-nian-gao 的界面应该像一个<strong>可靠、克制、安静的工具</strong>：
          用户先看到内容，再看到系统如何工作，最后才感知品牌。
        </p>
        <div className="philosophy-palette-summary">
          <span className="philosophy-palette__caption">
            核心六色摘要 · 完整 Light / Dark 色表见「颜色 · Color」
          </span>
          <div
            className="philosophy-palette"
            aria-label="核心六色摘要：纯白、近黑、灰阶、豆沙红、成功绿、失败红"
          >
            <span className="is-white" title="纯白" />
            <span className="is-black" title="近黑" />
            <span className="is-gray" title="灰阶" />
            <span className="is-bean" title="豆沙红" />
            <span className="is-success" title="成功绿" />
            <span className="is-danger" title="失败红" />
          </div>
        </div>
      </section>

      <section>
        <h2 className="color-section-title">四条原则</h2>
        <div className="philosophy-principles">
          {PRINCIPLES.map((principle, index) => (
            <article key={principle.title}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{principle.title}</h3>
              <p>{principle.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="color-section-title">唯一口径</h2>
        <div className="philosophy-rules">
          {RULES.map(([label, rule]) => (
            <div key={label}>
              <code>{label}</code>
              <p>{rule}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="color-section-title">给设计与实现的短提示</h2>
        <blockquote className="philosophy-prompt">
          设计一个安静、现代、低 AI 模板感的工具界面。Light 使用纯白阅读面，Dark 使用近黑阅读面；
          灰阶承担层级，豆沙红只用于品牌、选择、焦点和确认文字动作。正文统一无衬线，工具原始数据才用等宽。
          Process
          是可折叠的连续时间线：完成节点实心，唯一进行中节点轻微呼吸；成功绿、失败鲜红且必须带文字状态。
          确认问答嵌在原 Process
          中，回答后保留原问题与答案并继续，不拆回合。少容器、少阴影、无渐变、无装饰性类型标签。
        </blockquote>
      </section>
    </div>
  )
}
