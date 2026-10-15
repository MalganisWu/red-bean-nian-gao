# AGENTS.md · Frontend

Frontend 治理入口：目录边界、路由与命令。**编码规范与开发流程的规则本体在 Skill 里**，本文件不重复。

## 开始任务

1. 完整读取仓库根 [`AGENTS.md`](../AGENTS.md)。
2. 完整读取本文件。
3. 完整读取下面「编码规范」与「开发与测试流程」指向的 Skill——**规则本体在那里**。
   规则冲突时以离目标文件最近者为准。
4. 检查工作区状态，保留用户已有改动。

---
---

---

## 编码规范

按范围分工，**本节不重复规则正文**：

| 范围 | 唯一事实来源 |
|------|-------------|
| 通用 TypeScript（类型边界、`unknown`、可读性、判空、命名、注释） | [`../skills/red-bean-nian-gao-frontend-coding-conventions/references/common.md`](../skills/red-bean-nian-gao-frontend-coding-conventions/references/common.md) |
| React / UI 与 Design System（组件结构、样式、状态、导入顺序、API 调用、注释、门禁） | [`../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md`](../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md) |
| 产品视觉规范（色值、布局与响应式、图标、交互与无障碍、系统状态） | [`../skills/red-bean-nian-gao-visual-language/SKILL.md`](../skills/red-bean-nian-gao-visual-language/SKILL.md) |

冲突时以通用件为准。

---

## 开发与测试流程

新功能/变更按 6 阶段执行：**需求 → 计划 → 编码 → 验证 → 文档 → 交付**。

前端特有的差异：

- **阶段 1 与阶段 2 之间额外步骤：mock → 方向确认**
  1. 产出 mock，落 `design-system/previews/`（本地、不入库），由开发者目视确认方向
  2. 确认后才写 plan；plan 只写已确认的方向。**这不是所有 UI 改动的必经步骤**——已有设计约定、
     预期行为清楚的简单修复可直接实施；涉及新的外观或交互方案选择时，先问开发者要不要 mock
- **阶段 2 计划**：盘点需要的 UI 组件（哪些已有的、哪些要新建、哪些要改），定下复用还是新增的
  **方案**——本步不写组件代码
- **阶段 3 编码起步**：先在 design-system 完成真实组件 + Showcase 并目视确认（启动 design-system
  dev server），再开发正式前端
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

## 契约消费（硬性红线）

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

alias 映射表、漂移检查与 token 同步机制见
[`../design-system/AGENTS.md`](../design-system/AGENTS.md)「同步机制」，本节不重复。
修改 design-system 组件后，前端侧只需验证 `pnpm typecheck && pnpm build` 仍通过。

---

---

---

## 运行命令

日常几条；**完整门禁清单见
[`../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md`](../skills/red-bean-nian-gao-frontend-coding-conventions/SKILL.md)「门禁」**，
本节不重列。

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

---

## 项目概述

React 前端，AI Agent 对话界面。采用 Light / Dark 对等的 Quiet Tool UI。
技术栈：React 19 + TypeScript + Vite + Tailwind CSS 4 + Base UI。