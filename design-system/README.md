# red-bean-nian-gao Design System

red-bean-nian-gao 的设计规范与组件展示站。当前唯一视觉方向为 **Quiet Tool UI**：纯白 / 近黑阅读面、灰阶信息层级、少量豆沙红、成功绿与失败红，以及无衬线优先的对话排版。

## 运行

```bash
pnpm install --frozen-lockfile  # 仓库根执行：workspace 单 lockfile 全仓安装
pnpm --filter design-system dev
# http://localhost:5174
```

要求 Node.js >=24.9.0、<26 与 pnpm 11.x（项目声明并推荐 11.5.2）。仓库根目录可运行
`make doctor` 检查工具链版本和 package 声明。

## 检查

```bash
pnpm --filter design-system format:check
pnpm --filter design-system lint
pnpm --filter design-system typecheck
pnpm --filter design-system test
pnpm --filter design-system build
```

## 规范入口

| 页面 | 定义内容 |
|---|---|
| Philosophy | 设计总纲与唯一口径 |
| Color | Light / Dark token 与颜色使用边界 |
| Typography | 字体角色、字号、行高、字重与文字灰度 |
| Conversation | AssistantTurn、Process、Tool、Approval、Final 的完整交互规则 |
| Spacing | 4px 节奏、阅读宽度、回合距离与触控尺寸 |
| Radius | 0 / 6 / 8 / 12 的组件映射 |
| Shadow | 无阴影默认与浮层唯一例外 |

## 工程与覆盖规范

- [交互与无障碍](./docs/interaction-accessibility.md)
- [系统状态](./docs/system-states.md)
- [布局与响应式](./docs/layout-responsive.md)
- [图标规范](./docs/iconography.md)
- [正式前端 UI 覆盖表](./docs/frontend-ui-coverage.md)

## 视觉口径

- Light 默认；首次跟随系统，用户切换后持久化。Dark 与 Light 的结构和行为完全一致。
- 灰阶承担层级；豆沙红只用于品牌、选择、focus 和确认文字动作。
- 成功用绿色，失败用鲜红，且状态必须同时有文字或图标。
- 正文和界面统一使用无衬线正体；工具名、命令、路径、参数、结果才使用等宽。
- Final、Process、Tool 默认透明；用户消息可用弱灰背景；默认无阴影。
- Process 是一条可折叠的连续时间线，不显示 Think / Tool / Content 分类标签。
- 确认问答始终属于原 Process；回答后在原节点保留问题和答案，再继续执行。
- 确认按钮透明无填充，仅使用豆沙红文字，点击区域至少 44px 高。

## Token 架构

所有 CSS 变量遵循 **Primitive → Semantic → Component** 三层：

- Primitive：Light / Dark 原始值，如 `--color-bean-light`。
- Semantic：按用途命名，如 `--background`、`--foreground-muted`、`--action-confirm`、`--success`。
- Component：组件组合，如 `--button-default-bg`、`--input-border`。

组件只使用 Semantic 或 Component token，禁止把预览里的 Hex 复制进组件。

## 对话结构

```text
AssistantTurn
├─ Process
│  ├─ progress summary
│  ├─ tool
│  ├─ delegation
│  └─ approval node
└─ FinalAnswer
```

Process 展示可验证的进展，不承诺暴露模型原始思维。Pending 确认节点不能被折叠隐藏；回答后原地压缩并沿同一时间线继续。

## 同步协议

`design-system/src/components` 是前端共享组件来源；`showcase/`、`foundations/`、`App.tsx` 和 `tabs.ts` 只属于设计站。

- 组件内部使用相对路径 import。
- 新增或修改共享组件必须同步更新 showcase，并经人工目视确认。
- Token 获得设计确认后，再按项目同步流程更新正式前端；不要在文档评审阶段自动覆盖前端样式。

详细协作约束见 [AGENTS.md](./AGENTS.md)。
