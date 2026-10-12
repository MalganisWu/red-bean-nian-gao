/** 把设计哲学正文作为 Markdown 文件下载，供理念页上的下载入口调用。 */
export function downloadDesignPhilosophyMarkdown(): void {
  const markdown = `# red-bean-nian-gao Design System

> Status: Canonical · 2026-08-27

## 1. Core direction

red-bean-nian-gao 是一个安静、现代、低“AI 模板感”的工具界面。

- 纯白与近黑建立清晰阅读面，灰阶承担绝大多数层级。
- 豆沙红是受限的品牌与确认动作色，不承担成功、失败或大面积装饰。
- 成功使用绿色，失败使用鲜红；状态不能只靠颜色，必须带文字或图标。
- 正文、用户消息、进展、确认文案统一使用无衬线正体。
- 等宽字体只用于工具名、行内代码及展开后的参数、结果、错误原文；工具目标、耗时和状态保持无衬线。
- 不用卡片拼贴制造模块感；优先使用字号、灰度、留白和一条细线。

## 2. Design principles

### 2.1 Content first

最终回答是每轮的主角，使用最高文字对比度与 15px / 1.76 的阅读排版，在 Process 之后裸排进入阅读流。普通段落不增加整篇容器；标题、列表、引用和表格由 Markdown 结构建立层级，只有 fenced code block 使用带语言标签和复制动作的独立弱表面。过程信息降低字号与灰度，但不能低到不可读。

### 2.2 One continuous process

AssistantTurn 的结构固定为：

\`\`\`text
AssistantTurn
├─ Process
│  ├─ progress summary
│  ├─ tool
│  ├─ delegation
│  └─ approval node
└─ FinalAnswer
\`\`\`

用户被询问、确认回答、Agent 恢复执行，仍属于同一个 Process。Pending 时确认节点常显；回答后原地压缩成“原问题 + 用户答案”，时间线继续向下生长，不生成第二个过程。

### 2.3 Quiet hierarchy

Think、进展、Tool 不显示类型标签。所有过程事件按时间顺序共享同一条时间线：时间线内完成步骤为中性实心圆点；唯一进行中节点允许轻微呼吸；减少动效时改为中性静态实心点。摘要行的 completed / failed 终态点分别使用成功绿 / 失败红。

### 2.4 Semantic color

- Neutral: 内容结构、过程层级、边界、不可操作元信息。
- Red bean: 品牌、选中、键盘焦点和确认文字动作。
- Success green: 工具成功、已确认、明确完成状态。
- Danger red: 工具失败、提交失败、不可逆风险的错误状态。

状态色不能承担页面结构，禁止大面积成功绿 / 失败红背景。

### 2.5 Theme parity

Light 为默认；用户手动切换后持久化。Light 与 Dark 只替换语义 token，几何、字号、间距、折叠和状态行为完全一致。

## 3. Color tokens

所有 UI 颜色都必须从以下语义 token 读取。Light 与 Dark 使用同一角色名；即使两个角色当前颜色相同，也不得在组件里互相替代。

### 3.1 Surface & Border · 表面与边界

| Semantic token | Light | Dark | Use |
|---|---:|---:|---|
| background | #FFFFFF | #0B0B0C | 页面与 Agent 正文阅读面 |
| sidebar | #F6F6F5 | #111112 | 导航与固定侧栏 |
| card | #FFFFFF | #0B0B0C | 卡片与文档阅读面 |
| muted / surface-hover | #F2F4F5 | #1D1D1F | 用户消息、hover、弱分组 |
| popover | #FFFFFF | #1D1D1F | 菜单、提示、Toast 浮层 |
| input | #FFFFFF | #0B0B0C | 输入控件表面 |
| secondary | #F2F4F5 | #1D1D1F | 次级控件表面 |
| secondary-hover | #ECEBE8 | #262628 | 次级控件 hover |
| border / hairline | #DADCE0 | #242426 | 普通分隔线与卡片边界 |
| border-strong | #C8CBD0 | #363639 | 需要略强调的结构边界 |
| control-border | #8F949C | #5E5E63 | 输入、单选等必要控件边界 |
| ink | #0B0B0C | #050506 | 最高对比墨色与实体控件 |

### 3.2 Text & Tool · 文字与工具信息

| Semantic token | Light | Dark | Use |
|---|---:|---:|---|
| foreground / card-foreground | #101114 | #F3F2EF | 标题、关键结论与卡片前景 |
| foreground-body / secondary-foreground | #24262A | #D7D4D0 | 正文、用户消息与次级控件前景 |
| foreground-secondary | #494C52 | #AAA7A3 | 进展与辅助正文 |
| foreground-muted / muted-foreground | #656972 | #8C8883 | 时间、计数、状态元信息 |
| foreground-faint | #656972 | #8C8883 | 弱提示与图标 |
| foreground-faintest | #70747C | #817D78 | 最低层级但仍承载信息的文字 |
| process-node | #70747C | #77736F | 已完成的中性时间线节点 |
| process-node-active | #C87972 | #C87972 | 唯一进行中的呼吸节点 |
| process-title | #494C52 | #AAA6A1 | Process 摘要标题 |
| process-copy-active | #5D6169 | #B8B4AF | 当前进展叙述 |
| process-code | #34363B | #C8C4BF | Process 内机器数据 |
| tool-name | #34363B | #CFCBC6 | 工具名称 |
| tool-target | #5D6169 | #918D88 | 工具作用目标 |
| tool-duration | #70747C | #8C8883 | 工具与过程耗时 |
| delegation-name | #34363B | #B7B3AE | 子 Agent 名称 |
| question-copy | #494C52 | #A9A5A0 | 确认影响说明 |
| question-option | #5D6169 | #A9A5A0 | 未选中的确认选项 |
| code-inline-bg | #F2F4F5 | #1B1B1D | 行内代码背景 |
| code-inline-fg | #34363B | #D9D5D0 | 行内代码文字 |

### 3.3 Brand & Interaction · 品牌与交互

| Semantic token | Light | Dark | Use |
|---|---:|---:|---|
| brand-text / primary / action-confirm / accent | #99413C | #C87972 | 品牌文字、确认动作与兼容主色 |
| brand-indicator / selection-accent | #C87972 | #C87972 | 品牌图形、选中控件与活动导航 |
| focus-ring | #C87972 | #C87972 | 不透明 2px 键盘焦点环 |
| round-nav-marker | #8F949C | #5E5E63 | 未选中的可点击轮次标记；相对阅读面至少 3:1 |
| primary-hover / action-confirm-hover | #793E39 | #DF948D | 豆沙文字 hover / active |
| primary-soft / highlight-bg | #FAEEEE | #251817 | 品牌柔和背景与高亮底色 |
| primary-foreground / accent-foreground | #FFFFFF | #0B0B0C | 品牌实心表面的前景色 |
| highlight-fg | #793E39 | #DF948D | 品牌高亮文字 |

### 3.4 Status · 状态反馈

| Semantic token | Light | Dark | Use |
|---|---:|---:|---|
| success-text / success | #0F713D | #55C47B | 成功与已确认文字 |
| success-indicator | #2F9E58 | #55C47B | 成功图标与 5–7px 状态节点 |
| success-bg | #EAF8EF | #102719 | 成功柔和背景 |
| danger-text / danger / destructive | #B52A36 | #FF515E | 失败、错误与破坏性文字 |
| danger-indicator | #E04752 | #FF515E | 失败图标与 5–7px 状态节点 |
| danger-bg | #FFF0F2 | #2D1115 | 失败柔和背景 |
| destructive-foreground | #FFFFFF | #0B0B0C | 破坏性实心表面的前景色 |
| warning | #99413C | #C87972 | 克制的警告文字，当前复用品牌色 |
| warning-bg | #FAEEEE | #251817 | 警告柔和背景 |
| info | #494C52 | #AAA7A3 | 中性信息文字 |
| info-bg | #F2F4F5 | #1D1D1F | 中性信息背景 |

### 3.5 Category · 审计分类色

轨迹/审计场景的记录分类色，只用于 chip、节点、细条等小面积元素；正文摘要恒为中性色。LLM 步骤复用中性灰、用户复用品牌豆沙红，不为二者新增分类色。

| Semantic token | Light | Dark | Use |
|---|---:|---:|---|
| cat-tool-text | #3A5C7E | #9DBAD6 | 分类「工具」的文字 |
| cat-tool-indicator | #6E8FAE | #7FA0BF | 分类「工具」的节点与细条 |
| cat-tool-soft | #EDF2F7 | 混色 16% | 分类「工具」的软底；Dark 为 indicator 低透明度混合 |
| cat-sub-text | #486B53 | #A3C2AE | 分类「子 Agent」的文字 |
| cat-sub-indicator | #6E967E | #84A48F | 分类「子 Agent」的节点与细条 |
| cat-sub-soft | #EDF3EE | 混色 16% | 分类「子 Agent」的软底；Dark 同上 |
| cat-cmp-text | #6E5F49 | #C9B795 | 分类「压缩」的文字 |
| cat-cmp-indicator | #9C8B6E | #A89878 | 分类「压缩」的节点与虚线描边 |
| cat-cmp-soft | #F5F1EA | 混色 14% | 分类「压缩」的软底；Dark 同上 |

状态文字与状态图形必须使用不同角色：小字号文字使用较深的 text token，图标与节点使用更鲜活的 indicator token。状态节点不能成为唯一信息来源。普通容器使用 border；只有可交互控件使用 control-border。focus-ring 必须保持不透明 2px，并与控件边界留出 2px 间隔。

Color foundation 的色板标签使用展示站专用组件 token \`--swatch-label-overlay: rgb(0 0 0 / 60%)\` 配白字，保证浅色色块上的标签仍达到文字对比度要求；产品组件不得复用该 token。

## 4. Typography

Default:

\`\`\`css
font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
\`\`\`

Machine data:

\`\`\`css
font-family: "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace;
\`\`\`

Weights are fixed per canonical role: 400 for body/process copy, 450 for user messages, 500 for tool labels, 520 for Process titles, 550 for compact answered text, 600 for state labels, 620 for approval questions, and 650 for Final headings/actions. A fallback font may map an intermediate value to its nearest supported weight. Questions, actions and standalone information stay at least 12px; repeated Process summaries, QuestionCard eyebrows and machine-detail rows use the compact canonical exceptions listed below. Serif is optional for an explicitly entered long-reading or quotation mode; it is never the default conversation font.

The QuestionCard state eyebrow may use the canonical 10.5px / 600 treatment because the Process summary repeats that state. Questions, descriptions, options, answers and actions remain at least 12px.

| Role | Size / line-height / weight |
|---|---|
| Final answer | 15px / 1.76 / 400 |
| Mobile final | 14.5px / 1.76 / 400 |
| User message | 14px / 1.65 / 450; mobile 13.5px |
| Process progress | 13px / 1.7 / 400; mobile 12.5px |
| Process summary | 11.5px / 1.4 / 520 |
| Tool row | 12.5px / 1.7 / 400–600; name 11.5px / 500 mono |
| Tool detail | 10.5px / 1.75 / 400 mono |
| Tool status | 12.5px / 1.7 / 600 |
| Section heading | 20px / 1.35 / 650 |
| Approval title | 15px / 1.5 / 620 |

## 5. Surface, radius and shadow

- Surfaces are limited to canvas, sidebar, muted and overlay.
- Final, Process, Tool and result summary stay unframed; user messages may use muted. Only fenced code blocks use an independent muted surface with a language label and code-level copy action.
- Approval Pending 是 Process 内唯一允许完整 1px 强边界与 12px 圆角的高关注容器；无阴影、无彩色底。
- Radius scale: 0 / 6 / 8 / 12. Final content, Process, Tool and tables use 0; small controls 6; inputs/messages/buttons and fenced code blocks 8; Dialog/Popover 12.
- Default shadow is none. Only Menu, Popover, Dialog and Toast use \`0 8px 24px\` overlay shadow.

## 6. Confirmation action

- Transparent background, no persistent border, red-bean text only.
- Hover changes text shade only; focus-visible uses a clear 2px outline.
- Confirmation text actions use the canonical compact \`6px 0\` padding.
- At 760px and below, actions stack vertically and stay left-aligned.
- “暂不执行” uses neutral text and lower emphasis.
- 单选默认选中第一项；确认文案可随当前选项变化。
- Pending, selected, submitting, answered, refused, submit-error and stale states must be designed.
- Answer 在 SSE START 前失败时保持 Pending、保留草稿并允许重试；START 后失败时答案已经消费，原位显示 answered/refused、保留当前页已收到的续跑内容，并把 Process 标为 cancelled，禁止回滚重答。
- 异常 partial 目前不写入 backend DisplayMessages；刷新后必须保持卡片终态，但不承诺异常 partial 完整回放。

## 7. Process, Tool and Delegation states

- Process: running / awaiting / completed / failed / cancelled.
- Tool: running / success / failed / cancelled / incomplete.
- 单个 Tool 或子 Agent 失败不自动把整个 Process 标成失败；只有明确回合终态才能决定 Process failed。
- DONE、取消、断线或流异常后，仍在 running 的 Tool 必须递归落为 incomplete；cancelled 保留给未来明确的后端终态。
- 回合结束时仍为 running 的 delegation 同样派生为 incomplete，刷新回放不得继续显示“正在执行”。
- 子 Agent 通过 \`parent_call_id\` 归入父 Tool，与父 Tool 共用一个 Process 节点；委派内容缩进展示并继续使用同一灰阶与 Tool 语言，不创建第二套卡片或时间线。缺失关联 ID 的旧数据保留独立节点。

## 8. Writing style

Use short, direct and verifiable text:

- 过程已完成 · 7 步 · 12s
- 等待确认
- 会修改 settle.ts，不会调整公开接口
- 确认并继续

Avoid anthropomorphic or implementation-leaking copy such as “AI 正在思考”、decorative THINK / TOOL / CONTENT labels, and repetitive “我先……”。

## 9. Acceptance baseline

- Verify Light and Dark for Process running/completed/failed/awaiting/cancelled.
- Verify Tool running/success/failed/cancelled/incomplete/details and narrow-screen overflow.
- Verify Approval pending/selected/submitting/accepted/answered/refused/error, including a second question in the same Process.
- Verify Markdown headings, lists, tasks, quote, table, link and long wrapping; fenced code blocks must expose a language label, code-level copy feedback and local horizontal scrolling without framing the whole Final.
- Verify child-agent execution and scheduled-task result reuse the same Process / Tool / Markdown components.
- Verify task list, task detail, execution history, keyboard, focus-visible, reduced motion, 360px mobile and desktop reading width 720–760px.
`

  const blob = new Blob([markdown], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'red-bean-nian-gao-design-system.md'
  a.click()
  URL.revokeObjectURL(url)
}
