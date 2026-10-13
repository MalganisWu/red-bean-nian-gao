# AGENTS.md · Frontend

前端 AI 开发助手手册。写代码前先读本文件。

---

## 项目概述

React 前端，AI Agent 对话界面。采用 Light / Dark 对等的 Quiet Tool UI。
技术栈：React 19 + TypeScript + Vite + Tailwind CSS 4 + Base UI。

---

## API 契约同步（硬性红线）

**消费/新增任何后端接口前，先读 `../api-contract/src/`。`@red-bean/api-contract` 是机器唯一事实来源；
[`../docs/contracts/api.md`](../docs/contracts/api.md) 只提供语义说明与示例。**

- 消费接口：从共享包导入请求/响应 DTO、错误码、SSE 类型和运行时守卫，禁止复制后端类型。
- 禁止从 `backend/src` 导入；前端展示模型可以独立存在，但必须在明确的适配边界从共享 DTO 转换。
- API 路径由共享 `API_ROUTES` 命名表 + `buildPath` 提供；`src/lib/constants.ts` 只保留前端自有常量
  （`ROUTES`、`TOKEN_KEY`、`DEFAULT_AGENT_ID`），不再 re-export 契约路径。
- **机械校验**：`pnpm test`（或 `make fe-contract`）核对服务调用、路径常量和 SSE 守卫与共享契约一致，
  并检查人类文档仍是完整投影。

---

## 目录结构

```
frontend/
├── src/
│   ├── app/              # App 入口、路由、全局布局
│   ├── components/
│   │   ├── chat/         # 对话相关组件
│   │   ├── task/         # 定时任务相关组件
│   │   └── layout/       # 布局组件
│   ├── hooks/            # 自定义 hooks
│   ├── services/         # API 调用层
│   ├── stores/           # Zustand 状态管理
│   ├── types/            # TypeScript 类型定义
│   ├── styles/           # 全局样式 + design tokens
│   └── lib/              # 工具函数
├── docs/                 # 前端文档
└── public/               # 静态资源
```

> **`retroui/` 组件不在本仓库中维护。** 导入路径 `@/components/retroui/*` 通过 Vite alias 指向 `../design-system/src/components/`，design-system 是唯一源。

---

## 设计系统同步（硬性红线）

**共享 UI 组件、token 与基础视觉语言变更必须从 design-system 开始，经人工确认后再进入正式前端。**
页面级业务容器、路由和数据编排可以直接在 frontend 实现，但必须复用现有组件与 token；若形成可复用
模式，再提炼到 design-system。

```
design-system 组件 + showcase → 人工目视确认 → 前端使用
```

- **新增/修改 UI 组件**：在 `design-system/src/components/` 下操作，**禁止**在前端创建 retro ui 组件
- **Showcase 必须同步**：design-system 中每个公开组件必须有对应的 showcase 页，覆盖适用状态
- **人工确认 gate**：design-system dev server 目视确认后，前端才能在业务代码中使用
- **前端通过 alias 自动引用**：`@/components/retroui/*` → `../design-system/src/components/*`，无需手动复制

同步机制：

| 层 | 配置文件 | 映射 |
|----|---------|------|
| Vite | `vite.config.ts` | `@/components/retroui` → `../design-system/src/components` |
| TypeScript | `tsconfig.app.json` | `@/components/retroui/*` → `../design-system/src/components/*` |

**设计系统组件内部必须用相对路径 import**（`./ToolGroup`），因为跨项目加载时 `@/` 上下文不同。

修改 design-system 组件后，验证：
```bash
# 前端侧
pnpm typecheck && pnpm build

# design-system 侧
cd ../design-system && pnpm ai:check
```

---

## 编码规范速查

通用 TypeScript 规则见
[`../docs/standards/typescript-common-conventions.md`](../docs/standards/typescript-common-conventions.md)，
产品仓特有约束见 [`../docs/standards/typescript-coding-conventions.md`](../docs/standards/typescript-coding-conventions.md)，
React/UI 附加规则见 [`docs/standards/coding-conventions.md`](docs/standards/coding-conventions.md)。

| 规则 | 说明 |
|------|------|
| 类型约束 | 禁止 `any`、非空断言和无校验断言；导出及跨边界函数显式标注，简单局部值允许推导 |
| 注释 | 统一简体中文（专有名词保留原文）；公开 Props/方法/边界写清职责与原因，与代码同 diff 更新；测试 setup/断言原因优先中文（详共享通用规范「注释」） |
| 可读性 | 禁止调用点现场组装复杂参数（多字段对象先具名预构建）；禁止嵌套三元与 `...(cond ? {} : {...})` 展开（详根 TS 规范「表达式与调用可读性」） |
| 判空/命名 | 可空字段判空写法按字段类型选一种写全、不三种混用；私有成员用 `#`；参数"所有者/作用域在前"（详根 TS 规范「判空与可空映射」「命名与签名约定」） |
| Props | 用 `interface` 定义，放组件上方 |
| 组件结构 | 一个文件一个组件，函数组件 |
| 样式 | 禁止硬编码颜色，必须用 Tailwind utility + token |
| 导入顺序 | 第三方 → `@/` → 相对路径 |
| 三态原则 | 数据组件必覆盖 loading / success / error |
| 文件命名 | 组件 PascalCase，hook camelCase `use` 前缀 |

---

## 开发流程

新功能/变更按 6 阶段执行：**需求 → 计划 → 编码 → 验证 → 文档 → 交付**。

前端特有的差异：

- **阶段 2 额外步骤：UI 组件盘点 + design-system 先行**
  1. 盘点需要的 UI 组件（哪些已有的、哪些要新建、哪些要改）
  2. 在 design-system 完成组件设计 + showcase 页
  3. 人工目视确认（启动 design-system dev server）
  4. 确认后才进入阶段 3
- 阶段 3 **测试分层**：逻辑层严格 TDD；组件先定义验收状态，可自动化的交互行为测试先行；纯视觉层使用 Showcase + 目视验证
- 阶段 4 **硬性门禁**：format:check + typecheck + lint + test + build，外加 dev server 目视确认
- 阶段 5 涉及 design-system 变更的，验证两端 `typecheck + build` 均通过

**前端目录职责**：

| 目录 | 放什么 | 不放什么 |
|------|--------|---------|
| `components/chat/` | 对话业务组件（MessageCard 等） | UI 基础组件 |
| `components/task/` | 定时任务业务组件 | UI 基础组件 |
| `components/layout/` | 布局组件 | UI 基础组件 |
| `stores/` | Zustand 状态管理 | UI 逻辑 |
| `hooks/` | 自定义 hooks（useChatStream 等） | UI 逻辑 |
| `services/` | API 调用层 | - |
| `types/` | 前端类型定义 | 组件 Props 类型（从 design-system import） |

详见 → [`docs/standards/development-workflow.md`](docs/standards/development-workflow.md)

---

## 运行命令

```bash
pnpm install --frozen-lockfile # 仓库根执行：workspace 单 lockfile 全仓安装
pnpm dev           # 启动开发服务器 → http://localhost:5173
pnpm typecheck     # TypeScript 类型检查
pnpm lint          # ESLint
pnpm format:check  # Prettier 格式检查（只读）
pnpm format        # Prettier 格式修复（会写文件）
pnpm test          # Vitest 行为与契约测试
pnpm build         # 生产构建
pnpm check:drift   # Design System 组件与 token 漂移检查

# 仓库根目录
make doctor        # 检查工具链版本与 package 声明
make verify        # 后端、前端与 Design System 本地统一门禁
```
