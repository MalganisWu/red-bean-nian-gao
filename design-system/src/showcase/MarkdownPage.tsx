import { MarkdownAnswer } from '@/components/MarkdownAnswer'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

/**
 * 主样例：一段典型的最终回答，混合普通段落、二三级标题、无序列表、表格、
 * 引用块、带语言标签的代码围栏与外部链接。
 *
 * 它对应 `MarkdownAnswer`（整篇回答裸排、无外框），用来验证「只有代码围栏
 * 才形成独立容器」这条排版约定；正文颜色由语义令牌决定，Light / Dark 共用。
 */
const SAMPLE = `同步策略已经更新，普通正文直接进入阅读流，不额外套整篇容器。

## 本次变更

- 修改 \`retry.max\`：1 → 3
- 保持 \`retry.interval\`：5s
- 配置校验与单元测试均已通过

### 验证结果

| 检查 | 结果 | 耗时 |
|---|---|---:|
| 配置解析 | 成功 | 1s |
| 重试策略 | 成功 | 2s |
| 回归测试 | 成功 | 9s |

> 注意：只有同步失败会触发重试，用户主动取消不会重试。

\`\`\`yaml
retry:
  max: 3
  interval: 5s
\`\`\`

详情见 [同步策略说明](https://example.com)。`

/**
 * 边界样例：任务列表、删除线，以及一段不含空格的长连续标识符。
 *
 * 它对应 `MarkdownRenderer`（嵌进 Process / Delegation 的内容），专门压测
 * 长串字符是否在内容区内换行而不是撑出横向滚动。
 */
const EDGE_SAMPLE = `## 边界内容

- [x] 已完成构建
- [ ] 等待人工确认
- ~~旧方案已经弃用~~

长连续字符必须在当前内容区内处理：

\`task_01J9QGX2K8SVR4H3M6D1N7CPAW_task_01J9QGX2K8SVR4H3M6D1N7CPAW\``

/** 「Markdown」组件页：正文排版与代码围栏渲染的示例。 */
export function MarkdownPage() {
  return (
    <div className="conversation-showcase markdown-showcase">
      <SpecPageHeader
        title="Markdown 排版 · Markdown"
        description="最终回答裸排；普通段落与 Markdown 结构自然混排，只有代码围栏形成独立容器"
        note="GFM rendering · fenced code block 提供语言标签与原始代码复制。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Final answer</h3>
        <div className="markdown-specimen">
          <MarkdownAnswer content={SAMPLE} />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Embedded renderer</h3>
        <div className="markdown-specimen border-y border-border py-5">
          <MarkdownRenderer content={EDGE_SAMPLE} />
        </div>
        <p className="spec-section__note">
          MarkdownRenderer 也用于 Process 或 Delegation
          内嵌内容；不会给整段内容增加外框，代码围栏仍保留独立容器和复制动作。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>正文</strong>
            <p>桌面 15px / 1.76，移动端 14.5px / 1.76，400 字重，无衬线。</p>
          </div>
          <div>
            <strong>回答表面</strong>
            <p>整篇 Final 无背景、无边界、无圆角；普通段落直接进入页面阅读流。</p>
          </div>
          <div>
            <strong>标题</strong>
            <p>600 字重、自然字距；不使用全大写 Kicker 或装饰性引出线。</p>
          </div>
          <div>
            <strong>代码</strong>
            <p>行内代码保持轻量；围栏代码使用 muted 表面、8px 圆角、语言标签与独立复制动作。</p>
          </div>
          <div>
            <strong>表格</strong>
            <p>只用必要横线，表头不小于 12px；移动端允许容器内横向滚动。</p>
          </div>
          <div>
            <strong>复制</strong>
            <p>
              只复制当前代码围栏的原始内容；成功显示绿色“已复制”，失败显示鲜红“复制失败”，随后恢复。
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
