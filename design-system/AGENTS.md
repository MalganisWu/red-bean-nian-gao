# AGENTS.md · Design System

Design System 治理入口：目录边界、路由与命令。**编码规范与开发流程的规则本体在 Skill 里**，本文件不重复。

## 开始任务

1. 完整读取仓库根 [`AGENTS.md`](../AGENTS.md)。
2. 完整读取本文件。
3. 完整读取下面「编码规范」与「开发与测试流程」指向的 Skill——**规则本体在那里**。
   规则冲突时以离目标文件最近者为准。

## 编码规范

通用 TypeScript 规范遵循跨仓共享的
[`../docs/standards/typescript-common-conventions.md`](../docs/standards/typescript-common-conventions.md)，
前端与 Design System 的特有约束见
[`../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md`](../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md)；
**产品视觉规范**见
[`../skills/red-bean-nian-gao-visual-language/SKILL.md`](../skills/red-bean-nian-gao-visual-language/SKILL.md)。

## 开发与测试流程

通用流程见
[`../skills/red-bean-nian-gao-development-workflow/SKILL.md`](../skills/red-bean-nian-gao-development-workflow/SKILL.md)；
本 workspace 特有的流程红线见下面「开发流程（硬性红线）」。

---
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

通用 TypeScript 规范遵循跨仓共享的
[`docs/standards/typescript-common-conventions.md`](../docs/standards/typescript-common-conventions.md)，
前端与 Design System 的特有约束见 Skill
[`../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md`](../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md)。

---

## 开发流程（硬性红线）

**design-system 是共享组件、token 与基础视觉语言的唯一起点。** 页面路由、数据请求和一次性的业务
组合留在 frontend；当组合形成复用模式或需要改变基础视觉语言时，再进入 design-system 评审。

```
产出 mock → 人工确认 → 定义状态与视觉验收条件 → 设计/修改组件 → 写/更新 showcase 页 → 目视确认 → 前端才能使用该组件
```

前两步是「UI 变更 mock 先行」的落点：mock 只存在于本地 `previews/`，**不入库**，确认后才进入组件设计。
组件状态机（`proposal` → `accepted` → `implemented`）与各状态的准入条件见
[`skills/red-bean-nian-gao-development-workflow/SKILL.md`](../skills/red-bean-nian-gao-development-workflow/SKILL.md)「UI 变更：mock 先行」。

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
## 视觉风格核心

视觉语言是 **Quiet Tool UI**。色值、Dark 对等、灰阶层级、字体角色、圆角与阴影的**唯一事实来源**
是 [`../skills/red-bean-nian-gao-visual-language/SKILL.md`](../skills/red-bean-nian-gao-visual-language/SKILL.md)；
可运行的规范在 `src/foundations/`（Philosophy、Color、Typography、Spacing、Radius、Shadow、
Conversation），token 的单一实现源是 `src/styles/design-tokens.css`。

---

## 组件与 Token

组件怎么进册、Showcase 要覆盖哪些状态、组件内部 import 用相对路径还是 alias、token 的三层层级
与 Light/Dark 约束、样式硬编码的 ESLint 规则与替换表——全在前端编码规范 Skill 的
[`red-bean-nian-gao-frontend-coding-conventions`](../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md)
「Design System 组件」「Token 架构」「样式」三节。

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

---

## 项目概述

Quiet Tool UI 的可视化展示站点。独立于前端，提供 design token、组件示例和风格指南的集中展示。
技术栈：React 19 + TypeScript + Vite + Tailwind CSS 4。