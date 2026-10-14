# 正式前端 UI 覆盖表

本表记录正式前端与设计系统的对应关系。页面业务容器无需复制到设计系统，但其可复用组件、视觉状态和交互契约必须可追溯。

| 正式场景 | 设计系统入口 | 覆盖要求 |
|---|---|---|
| 会话消息与过程 | Conversation / ProcessFold / Agent Delegation / QuestionCard / Markdown | 空会话、流式、停止、失败重试、父工具内委派、pending 确认、最终回答 |
| 会话侧栏与账号 | Avatar / Menu | 新建、搜索、重命名、删除、折叠、移动抽屉、Account 菜单 |
| 定时任务 | Scheduled Tasks | 列表、任务概览、执行记录、单次执行及各自 loading/empty/error |
| 登录与注册 | 本文 + 系统状态规范 | 提交、字段错误、服务错误、认证恢复、移动端 |
| 个人资料 | Avatar / Input / Menu + 系统状态规范 | 头像失败、长用户名、保存中、保存成功/失败 |
| 页面外壳 | Brand / Button / Menu / Toast | 返回、主题切换、页面标题、全局反馈 |

## 当前已覆盖

- 会话 Process 的时间线、工具结果、父工具内子 Agent 委派、确认问答与裸排 Markdown 最终回答；代码围栏独立显示语言标签和复制反馈。
- 定时任务的任务列表、任务概览、执行记录和单次执行层级。
- Button、Input、Avatar、Menu、Tooltip、Toast 和品牌标记。
- Light / Dark 主题语义 token 与基础排版、间距、圆角、阴影。

## 新增文档覆盖

- 认证、个人页、聊天与定时任务的通用状态矩阵。
- 无障碍、响应式、图标、示例隐私与设计变更治理。
- Account 示例固定使用虚构身份：张三 / `san.zhang` / `san.zhang@example.com`。

## 已确认的收口决策

- 用户消息使用随内容收缩、受最大宽度约束的 `rounded-lg` muted 气泡，不增加仅作装饰的豆沙红圆点。
- Final 不使用整篇外框或常驻复制按钮；只有 fenced code block 使用独立弱表面、语言标签和代码级复制动作。
- 顶部栏使用不透明 `background` 与底边框，不保留 backdrop blur。
- 任务启停显示原位 pending 文案并用 toast 报告结果；删除采用两步确认、pending 与成功/失败反馈。
- focus、普通边界、控件边界和弱文字已经拆为独立语义 token，Light / Dark 分别校准。
- 不预建没有真实消费方的 FormField、Composer、IconButton、TextTabs 或 StatusIndicator；出现稳定复用
  需求时再按组件入册规则提炼。当前页面可以用既有原子件和 token 组合业务容器。

后续新增 Preview 必须标注 proposal，不进版本库，也不得在未确认前混入 canonical Showcase 或正式前端。
