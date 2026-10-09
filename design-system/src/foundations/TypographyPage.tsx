import './TypographyPage.css'

const ROLES = [
  ['页面标题', '20px / 1.35 / 650', '无衬线', '章节入口；避免超大 Hero 标题'],
  ['最终回答', '15px / 1.76 / 400', '无衬线', '主阅读内容；移动端 14.5px'],
  ['用户消息', '14px / 1.65 / 450', '无衬线', '移动端 13.5px；正体、无气泡尾'],
  ['进展叙述', '13px / 1.7 / 400', '无衬线', '移动端 12.5px；不加 Think 标签'],
  ['Process 摘要', '11.5px / 1.4 / 520', '无衬线', '状态重复的紧凑摘要，可低于 12px'],
  ['工具行', '12.5px / 1.7 / 400–600', '混合', '名称 11.5px 等宽；目标与状态无衬线'],
  ['工具详情', '10.5px / 1.75 / 400', '等宽', '参数、结果、错误原文'],
  ['状态与时间', '12.5px / 1.7 / 600', '无衬线', '状态不可只靠颜色'],
  ['确认标题', '15px / 1.5 / 620', '无衬线', '问题与影响范围'],
  ['输入', '13.5px / 1.5 / 400', '无衬线', 'Composer 控件 34px 高'],
] as const

const WEIGHTS = [
  ['400', 'Regular', '最终回答、过程叙述、工具详情'],
  ['450', 'Book', '用户消息'],
  ['500', 'Medium', '工具名称、普通标签'],
  ['520', 'Process', 'Process 状态标题'],
  ['550', 'Answer', '确认后的问题与完成提示'],
  ['600', 'Semibold', '状态、标签、回答标签'],
  ['620', 'Question', '确认问题'],
  ['650', 'Heading', 'Final 标题与确认动作'],
] as const

export function TypographyPage() {
  return (
    <div className="module-container typography-page">
      <header className="module-header">
        <div>
          <h2>排版 · Typography</h2>
          <p>无衬线负责沟通，等宽字体只负责机器原样</p>
        </div>
      </header>

      <section>
        <h2 className="color-section-title">Font family · 两个明确角色</h2>
        <div className="typography-families">
          <article>
            <span>Default / Sans</span>
            <h3>现代、克制、适合连续工作</h3>
            <p className="typography-families__sample is-sans">
              先确认修改范围，再继续执行。界面把注意力留给内容。
            </p>
            <code>
              Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC,
              Microsoft YaHei, sans-serif
            </code>
            <p>用于所有正文、用户消息、过程叙述、确认文案、状态、按钮、输入与导航。</p>
          </article>
          <article>
            <span>Machine / Mono</span>
            <h3>仅保留机器原样</h3>
            <p className="typography-families__sample is-mono">read_file · config/sync.yaml · 1s</p>
            <code>SFMono-Regular, SF Mono, Consolas, Liberation Mono, monospace</code>
            <p>
              只用于工具名、行内代码及展开后的参数、结果和错误原文；工具目标、时间、步数与状态不用等宽。
            </p>
          </article>
        </div>
        <p className="typography-page__aside">
          Noto Serif SC
          只可用于用户主动进入的长文阅读或引用模式，不是默认对话字体，也不用于制造“高级感”。
        </p>
      </section>

      <section>
        <h2 className="color-section-title">Hierarchy · 同一字体，不同灰度</h2>
        <div className="typography-hierarchy">
          <div className="typography-hierarchy__answer">
            已完成策略调整。失败后最多重试 3 次，间隔保持 5 秒。
          </div>
          <div className="typography-hierarchy__progress">
            已读取配置并确认影响范围，准备写入变更。
          </div>
          <div className="typography-hierarchy__tool">
            <code>apply_patch</code>
            <span>config/sync.yaml</span>
            <span className="is-success">成功</span>
          </div>
          <div className="typography-hierarchy__meta">6 步 · 12s</div>
        </div>
        <p className="typography-page__aside">
          Process 内不靠“思考 / 进展 / 工具”标题反复分类，而用灰度、字号和少量等宽字段形成层级。
        </p>
      </section>

      <section>
        <h2 className="color-section-title">Type map · 元素到字体</h2>
        <div className="typography-table-wrap">
          <table className="typography-table">
            <thead>
              <tr>
                <th>元素</th>
                <th>字号 / 行高 / 字重</th>
                <th>字体</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, index) => (
                    <td key={cell} className={index === 1 ? 'is-measure' : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="color-section-title">Weight · 逐角色固定</h2>
        <div className="typography-weights">
          {WEIGHTS.map(([weight, name, use]) => (
            <article key={weight} className={`is-weight-${weight}`}>
              <span>{weight}</span>
              <h3>{name}</h3>
              <p>{use}</p>
            </article>
          ))}
        </div>
        <p className="typography-page__aside">
          这些数值逐项来自 canonical；若中文系统字体不支持中间档，会自然回退到最近可用字重。
        </p>
      </section>

      <section>
        <h2 className="color-section-title">Do / Don’t</h2>
        <div className="typography-do-dont">
          <div className="is-do">
            <strong>Do</strong>
            <p>短句、正体、自然字距；层级来自字号、字重、灰度与留白。</p>
          </div>
          <div className="is-dont">
            <strong>Don’t</strong>
            <p>正文斜体、全大写 Kicker、超宽字距、10px 信息字，以及为每种内容换一种字体。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
