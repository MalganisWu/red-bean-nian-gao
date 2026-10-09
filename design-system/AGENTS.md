# AGENTS.md · Design System

设计系统 AI 开发助手手册。写代码前先读本文件。

---

## 项目概述

Quiet Tool UI 的可视化展示站点。独立于前端，提供 design token、组件示例和风格指南的集中展示。
技术栈：React 19 + TypeScript + Vite + Tailwind CSS 4。

---

## 目录结构

```
design-system/
├── src/
│   ├── app/              # App 入口 + 导航
│   ├── components/       # 设计系统组件（前端 UI 唯一源）
│   ├── foundations/      # 基础展示页（Philosophy, Color, Typography, Shadow, Radius, Spacing）
│   ├── showcase/         # 组件展示页（每个组件必须有对应的展示页）
│   └── styles/           # 全局样式 + design-tokens.css（单一真实来源）
└── public/
```

通用 TypeScript 规范遵循
[`docs/standards/typescript-coding-conventions.md`](../docs/standards/typescript-coding-conventions.md)，React/UI 规则遵循
[`frontend/docs/standards/coding-conventions.md`](../frontend/docs/standards/coding-conventions.md)。

---

## 开发流程（硬性红线）

**design-system 是共享组件、token 与基础视觉语言的唯一起点。** 页面路由、数据请求和一次性的业务
组合留在 frontend；当组合形成复用模式或需要改变基础视觉语言时，再进入 design-system 评审。

```
定义状态与视觉验收条件 → 设计/修改组件 → 写/更新 showcase 页 → 人工目视确认 → 前端才能使用该组件
```

1. **验收先行**：实现前列出 Default、交互和边界状态；视觉缺陷先保存可复现的页面或截图证据
2. **组件变更**：在 `src/components/` 下创建或修改组件
3. **Showcase 必须同步**：在 `src/showcase/` 创建/更新对应的展示页，注册到 `tabs.ts` 和 `App.tsx`
4. **人工确认 gate**：启动 dev server，人工在浏览器中确认组件各状态正确
5. **交互测试**：可自动化的键盘、点击、禁用和状态切换行为先写测试，并由 `pnpm test` 验证
6. **前端自动生效**：前端通过 Vite alias 引用 design-system，无需手动复制

**绝对禁止**：

- 跳过 showcase 直接写前端代码
- 在前端本地创建/修改 retroui 组件（前端 `components/retroui/` 目录已删除）
- 组件变更后不更新 showcase 页

---

## 视觉评审路由

明确要求评审新功能、页面、组件、主题或视觉方案时，使用仓库级
`design-system-visual-review` Skill 执行双专家独立评审。Skill 只定义评审流程与评分方法；颜色、排版、组件和交互规则仍以本文件及实际 Foundation、Showcase、token 和前端消费页面为准。

---

## 组件入册规则（防漂移，2026-08-26 瘦身对齐后生效）

1. **design-system 只收前端可直接 import 的组件**（原子件 + 共享复合件）。每个组件必须有真实的前端消费方（或当次需求即将接入）。
2. **禁止「模仿前端页面结构」的拷贝式场景页**。连接路由、Store 或 API 的页面级业务容器（如 `TaskDetailPanel`）留在 frontend；可被多个页面直接消费、无业务依赖的纯展示复合件（如 `ScheduledTaskOverview`）可以入册。Showcase 必须直接渲染真实组件，不能手写视觉副本。
3. **禁止「先做组件等前端用」**。没有消费方的组件不入册。
4. **内部件**（如 `ToolItem`）：仅被其他组件内部依赖，不单独出 showcase 页，不对外承诺 API，文件头注释标注「内部件」。

---

## Showcase 页面规范

每个组件 showcase 页必须覆盖以下状态：

| 状态              | 说明                       |
| ----------------- | -------------------------- |
| Default           | 组件默认外观               |
| Variants          | 所有 variant/size 组合     |
| Loading/Streaming | 流式或加载中状态（如适用） |
| Empty             | 空数据状态（如适用）       |
| Error             | 错误状态（如适用）         |

展示页模板参考现有 `ButtonsActionsPage.tsx`、`InputPage.tsx` 等。

新增组件时 checklist：

- [ ] 组件文件在 `src/components/`
- [ ] Showcase 页在 `src/showcase/`
- [ ] Tab ID 注册到 `tabs.ts`
- [ ] Page 注册到 `App.tsx` 的 `PAGES` 映射
- [ ] 启动 dev server 目视确认
- [ ] 有交互行为时已补测试
- [ ] `pnpm ai:check` 通过

---

## 组件设计规范

- **组件内部 import 用相对路径**（`./ToolItem`），不用 `@/components/retroui/...`。因为前端通过 Vite alias 加载时 `@/` 上下文不同。
- 只有 showcase/foundations/app 层可用 `@/` alias import。
- 组件必须 self-contained：不依赖 showcase 或 app 层代码。

## 组件注释规范

注释语言与共性规则见根
[`docs/standards/typescript-coding-conventions.md`「中文注释」](../docs/standards/typescript-coding-conventions.md)
与 [`frontend/docs/standards/coding-conventions.md` §9](../frontend/docs/standards/coding-conventions.md)，
本节只列 design-system 特有要求：

- **Props 注释即对外 API 文档**：组件被前端经 alias 跨项目消费，每个公开 Props 成员必须 JSDoc 说明
  用途、缺省值、`undefined` 语义与状态组合；改 Props 必须同 diff 更新注释，否则视为破坏前端契约文档
- **文件头职责注释**：每个组件文件头标明角色（原子件 / 复合件 / 内部件）与消费场景；
  内部件必须在文件头标注「内部件」（与组件入册规则 §4 呼应，如 `ToolItem`、`MarkdownCodeBlock`）
- **视觉/交互决策注释 why**：开合状态保留、兼容旧调用方映射、动效偏好等反直觉行为必须写原因，
  组件注释是前端开发者唯一的本地文档
- **测试注释**：交互测试的 setup、故障注入与断言原因用中文；用例名允许英文描述风格
- 注释语言不做机械门禁（协议名、URL、TS 指令会被误报），由 review 与交付前人工扫描负责

---

## Token 架构（三层级）

CSS 变量遵循 **Primitive → Semantic → Component** 三层层级，定义在 `src/styles/design-tokens.css`（单一真实来源）：

- **Primitive**：原始色值（如 `--color-bean-light: #99413C`）
- **Semantic**：按用途命名，并由 light/dark 主题映射（如 `--action-confirm`、`--success`）
- **Component**：组件级组合（`--button-default-bg: var(--primary)`）

颜色角色必须完整记录在 Color foundation 与 `philosophyMarkdown.ts`：文字、indicator、selection、focus、surface、普通边框和控件边框不得合并成一个泛化 token。状态文字使用 `--success-text` / `--danger-text`，图标与节点使用 `--success-indicator` / `--danger-indicator`；兼容别名 `--success` / `--danger` 只代表文字色。

---

## 视觉风格核心

视觉语言是 **Quiet Tool UI**。完整规范见 Philosophy、Color、Typography 与 Conversation 页面；`src/foundations/philosophyMarkdown.ts` 是可下载的文字版本。

- Light 默认、Dark 对等：纯白 `#FFFFFF` / 近黑 `#0B0B0C` 阅读面，几何和行为完全一致
- 灰阶承担层级；Light 品牌文字 `#99413C`、品牌图形/选择/focus `#C87972`，Dark 对应角色均为 `#C87972`；品牌色仅用于身份、交互与确认动作
- 成功绿、失败鲜红，只表达状态；状态必须同时有文字或图标
- 默认使用 canonical 的 Inter + 系统无衬线栈；等宽字体只用于工具名、行内代码及展开后的参数/结果/错误原文，目标、耗时与状态保持无衬线；字重按角色固定
- Final 与普通段落保持裸排；标题、列表、引用和表格依靠 Markdown 排版建立层级，只有 fenced code block 使用带语言标签和复制动作的独立弱表面；Process、Tool 保持透明，用户消息使用随内容收缩、受最大宽度约束的 muted 表面
- Process 是连续时间线：不显示 Think / Tool / Content 分类标签；完成节点实心，唯一进行中节点轻微呼吸
- 确认问答属于原 Process；Pending 常显，回答后原地收缩为“问题 + 回答”并继续，不拆成第二个过程
- 确认按钮无填充、无常驻边框，仅使用豆沙红文字；沿用 canonical 的 `6px 0` 紧凑内边距
- 圆角只保留 0 / 6 / 8 / 12；默认无阴影，仅浮层使用一档 `0 8px 24px` 阴影

---

## ESLint 强制规则

| 规则                             | 说明                                              |
| -------------------------------- | ------------------------------------------------- |
| 禁止 `#hex` 硬编码               | 必须用 Tailwind utility 或 `var(--color-*)` token |
| 禁止 `rgba()` 硬编码             | 必须用 token                                      |
| 禁止 inline style color/fontSize | 必须用 Tailwind utility                           |
| Foundations/styles 文件豁免      | 这些文件刻意展示原始值                            |

### Tailwind 硬编码 utility 替换（CVA 字符串内 ESLint 无法检测，需人工遵守）

| 禁止            | 替换                    |
| --------------- | ----------------------- |
| `bg-white`      | `bg-popover`            |
| `text-black`    | `text-foreground`       |
| `border-black`  | `border-border`         |
| `text-gray-700` | `text-muted-foreground` |

---

## 同步机制（design-system → frontend）

前端通过 Vite alias 直接引用 design-system 组件，**无需手动复制**。

| 层         | 配置文件                     | 映射                                                           |
| ---------- | ---------------------------- | -------------------------------------------------------------- |
| Vite       | `frontend/vite.config.ts`    | `@/components/retroui` → `../design-system/src/components`     |
| TypeScript | `frontend/tsconfig.app.json` | `@/components/retroui/*` → `../design-system/src/components/*` |

修改 design-system 组件后，只需验证前端仍然通过：

```bash
cd ../frontend && pnpm typecheck && pnpm build
```

漂移检查（每次门槛顺带跑）：

```bash
pnpm check:drift   # 或 bash ../scripts/check-ds-drift.sh
```

- **MISSING（exit 1）**：前端引用了 design-system 不存在的组件——必须立即修
- **NO-SHOWCASE（exit 1）**：公开组件缺少 showcase——必须在交付前补齐
- **DEAD（警告）**：组件前端暂时零引用——允许设计先行阶段出现，但最终应删除或在当次接入
- 内部件白名单在脚本顶部 `INTERNAL` 数组（`ToolItem`、`MarkdownCodeBlock`）

Token 同步：`frontend/src/styles/globals.css` 直接 `@import`
`design-system/src/styles/design-tokens.css`，不复制第二份 token；修改后两端自动一致。

前端与 Design System 共用仓库根 `.prettierrc`；两个 package 各自声明相同版本的 Prettier，检查时不
跨 package 借用 `node_modules`。

**不同步到前端的**：showcase/、foundations/、App.tsx、tabs.ts（design-system 专属展示代码，前端不需要）

---

## 运行命令

```bash
pnpm install --frozen-lockfile # 仓库根执行：workspace 单 lockfile 全仓安装
pnpm dev           # 启动开发服务器 → http://localhost:5174
pnpm test          # Vitest 组件交互测试
pnpm ai:check      # lint + format:check + typecheck + test + build + drift

# 仓库根目录
make doctor        # 检查工具链版本与 package 声明
make verify        # 后端、前端与 Design System 本地统一门禁
```
