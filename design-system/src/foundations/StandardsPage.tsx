import './StandardsPage.css'

/**
 * 资产治理归属表：`[类型, 唯一来源, 约束]`。
 *
 * 回答「这类东西该放哪、由谁负责」——Token / Component / Showcase / Proposal 四种类型各自的
 * 落地目录与准入条件，防止同一份实现出现多处副本。
 */
const GOVERNANCE = [
  ['Token', 'design-tokens.css', 'Primitive → Semantic → Component；组件禁止复制 Hex。'],
  ['Component', 'src/components', '只收正式前端已消费或本次即将接入的共享组件。'],
  ['Showcase', 'src/showcase', '直接渲染真实组件，并覆盖适用的边缘状态。'],
  ['Proposal', 'previews（本地，不入库）', '会改变既有视觉或行为的方案；确认前不进入正式前端。'],
] as const

/**
 * 系统状态行：`[状态, 呈现方式, 必须动作]`。
 *
 * 列出所有界面都要覆盖的通用状态（加载、空、刷新、成功、失败），并给每个状态绑定额外的必做
 * 动作，避免只画一种「成功态」而漏掉恢复路径。
 */
const STATE_ROWS = [
  ['Initial / Loading', '稳定占位 + 具体动作', '允许返回或取消；阻止相同请求重复提交'],
  ['Empty', '说明为空的原因', '给出创建、返回或清除筛选入口'],
  ['Refreshing', '保留已有内容 + 弱提示', '内容继续可读，只锁定冲突动作'],
  ['Success', '结果与必要后续', '成功绿同时配文字或图标'],
  ['Error', '失败对象、影响与恢复方式', '恢复可操作状态，并提供重试或返回'],
] as const

/**
 * 正式前端覆盖矩阵：`[场景, 涉及的组件, 需覆盖的状态]`。
 *
 * 按业务场景列出已消费的共享组件及其需要展示的边缘状态，既是「Showcase 应渲染什么」的清单，
 * 也是评估设计系统覆盖度的依据。
 */
const COVERAGE = [
  [
    '会话',
    'Conversation · ProcessFold · QuestionCard · Markdown',
    '空会话、流式、停止、失败、确认',
  ],
  ['账号', 'Avatar · Menu', '虚构身份、长文本、菜单、移动抽屉'],
  ['定时任务', 'Scheduled Tasks', '列表、概览、执行记录、单次执行'],
  ['认证与个人页', 'Input · Button · Avatar + 状态规范', '提交、恢复、字段错误、保存反馈'],
  ['页面外壳', 'Brand · Menu · Toast', '返回、主题切换、全局反馈'],
] as const

/**
 * 交互与无障碍检查项清单。
 *
 * 每条都是可验证的硬约束（焦点管理、触控目标、颜色非唯一线索、长内容换行、动效与缩放），
 * 作为提交前的自检项，任一条不满足即视为未达交付标准。
 */
const ACCESSIBILITY = [
  '键盘可达，使用 focus-visible；关闭浮层后焦点回到触发器。',
  '触控目标至少 44 × 44px；必要信息不低于 12px。',
  '状态不能只靠颜色，成功、失败、未读和进行中必须配文字或图标。',
  '长路径、URL 与代码在组件内部换行或滚动，不撑破页面。',
  '支持 prefers-reduced-motion，并检查 200% 缩放与 360px 宽度。',
] as const

/** 「规范」页：资产治理归属表与交互状态清单。 */
export function StandardsPage() {
  return (
    <div className="module-container standards-page">
      <header className="module-header">
        <div>
          <h2>规范与覆盖 · Standards</h2>
          <p>治理、无障碍、系统状态、响应式与正式前端覆盖的工程契约。</p>
          <p className="hint">Canonical · 新增规范；视觉修改仍需先通过 Preview 评审。</p>
        </div>
      </header>

      <section>
        <h2 className="section-title">单一事实来源</h2>
        <div className="standards-table" role="table" aria-label="设计系统治理">
          {GOVERNANCE.map(([type, source, rule]) => (
            <div className="standards-table__row" role="row" key={type}>
              <strong role="cell">{type}</strong>
              <code role="cell">{source}</code>
              <p role="cell">{rule}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">状态模型</h2>
        <div className="standards-table standards-table--state" role="table" aria-label="系统状态">
          {STATE_ROWS.map(([state, presentation, action]) => (
            <div className="standards-table__row" role="row" key={state}>
              <strong role="cell">{state}</strong>
              <p role="cell">{presentation}</p>
              <p role="cell">{action}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="standards-split">
        <div>
          <h2 className="section-title">交互与无障碍</h2>
          <ol className="standards-checklist">
            {ACCESSIBILITY.map((item, index) => (
              <li key={item}>
                <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <p>{item}</p>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h2 className="section-title">响应式基线</h2>
          <div className="standards-breakpoints">
            <div>
              <strong>≥ 1024px</strong>
              <p>侧栏与主内容并列，管理页保留多列。</p>
            </div>
            <div>
              <strong>761–1023px</strong>
              <p>压缩间距，次要字段换行，不移除主动作。</p>
            </div>
            <div>
              <strong>≤ 760px</strong>
              <p>侧栏转抽屉，表格局部滚动，RoundNav 隐藏。</p>
            </div>
            <div>
              <strong>≤ 360px</strong>
              <p>验证长文本、确认卡、代码块和按钮不溢出。</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="section-title">正式前端覆盖</h2>
        <div
          className="standards-table standards-table--coverage"
          role="table"
          aria-label="正式前端 UI 覆盖"
        >
          {COVERAGE.map(([scene, source, states]) => (
            <div className="standards-table__row" role="row" key={scene}>
              <strong role="cell">{scene}</strong>
              <p role="cell">{source}</p>
              <p role="cell">{states}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">示例数据与隐私</h2>
        <div className="standards-account" aria-label="Account 虚构身份示例">
          <span className="standards-account__avatar" aria-hidden="true">
            张
          </span>
          <span>
            <strong>张三</strong>
            <small>san.zhang · san.zhang@example.com</small>
          </span>
          <p>Showcase 与 Mock 不使用开发者真实姓名、用户名、邮箱、密钥或绝对本机路径。</p>
        </div>
      </section>

      <section>
        <h2 className="section-title">详细文档</h2>
        <p className="standards-doc-note">
          工程细则位于 <code>design-system/docs/</code>：frontend-ui-coverage；产品视觉规范见仓库级
          Skill <code>red-bean-nian-gao-visual-language</code>。
        </p>
      </section>
    </div>
  )
}
