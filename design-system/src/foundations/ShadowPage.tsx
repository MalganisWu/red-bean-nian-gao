import './ShadowPage.css'

/** 「阴影」基础页：文档流与浮层两级高度——默认没有阴影。 */
export function ShadowPage() {
  return (
    <div className="module-container shadow-page">
      <header className="module-header">
        <div>
          <h2>阴影 · Shadow</h2>
          <p>默认没有阴影；只有真正离开文档流的浮层需要表达高度</p>
        </div>
      </header>

      <section>
        <h2 className="color-section-title">Two levels · 文档流与浮层</h2>
        <div className="shadow-levels">
          <article>
            <div className="shadow-levels__surface">Surface</div>
            <h3>普通内容 · none</h3>
            <p>页面、Final、Process、Tool、用户消息、输入区和设置面板默认无阴影。</p>
            <code>box-shadow: none</code>
          </article>
          <article>
            <div className="shadow-levels__overlay">Overlay</div>
            <h3>脱离文档流 · overlay</h3>
            <p>仅 Menu、Popover、Dialog、Toast 使用一档柔和阴影，并始终配合清晰边框。</p>
            <code>0 8px 24px rgb(17 17 15 / 8%)</code>
          </article>
        </div>
      </section>

      <section>
        <h2 className="color-section-title">Exception · 固定输入区</h2>
        <div className="shadow-composer-rule">
          <strong>优先使用顶部 1px 分隔线。</strong>
          <p>
            只有内容滚动到输入区下方、分隔线仍不足以表达层级时，才可使用极弱的向上阴影
            <code>0 -4px 16px rgb(17 17 15 / 4%)</code>；不能把输入区做成漂浮卡片。
          </p>
        </div>
      </section>
    </div>
  )
}
