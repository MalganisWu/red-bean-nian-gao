# AGENTS.md

AI 开发助手入口。本文件是**治理入口**：项目边界、路由、协作权限与命令。
**编码规范与开发流程的规则本体在 Skill 里**（见「[Skill](#skill)」节），本节不重复。

---

## 开始任务

1. 完整读取本文件（根 `AGENTS.md`）。
2. 按将要读写的路径，完整读取沿途适用的模块级 `AGENTS.md`；规则冲突时以离目标文件最近者为准。
3. 读取本次任务适用的 Skill（见「[Skill](#skill)」节）——**编码规范与开发流程的规则本体在那里**。
4. 检查工作区状态，保留用户已有改动；范围或权限不明确时先确认。

## 编码规范

写 TypeScript 代码前，完整读取
[`skills/red-bean-nian-gao-coding-conventions/SKILL.md`](skills/red-bean-nian-gao-coding-conventions/SKILL.md)
及其 [`references/common.md`](skills/red-bean-nian-gao-coding-conventions/references/common.md)。

前者是本仓编码规则的**唯一事实来源**（语言与风格、注释、兼容性与判断边界、前端与 Design System、
契约来源、HTTP 边界与 Controller、组装与实现绑定、门禁）；后者是**跨仓共享**的通用 TypeScript 规则。

## 开发与测试流程

任何开发任务前，完整读取
[`skills/red-bean-nian-gao-development-workflow/SKILL.md`](skills/red-bean-nian-gao-development-workflow/SKILL.md)
及其 [`references/common.md`](skills/red-bean-nian-gao-development-workflow/references/common.md)。

前者写本仓特有的流程落点（四个 workspace 的流程文档位置、plan 落点、模块级判定）；后者是
**跨仓共享**的通用流程（一次开发的产出 plan / decision / design 及触发判据、三条红线、各自骨架、
验收条件去向、变更分级、六阶段、执行纪律、文档影响审查、交付核验）。

## 子模块路由

| 你想做什么 | 去哪里读 |
| --- | --- |
| 改后端代码 | [`backend/AGENTS.md`](backend/AGENTS.md) + [`backend/docs/standards/`](backend/docs/standards/) |
| 人工追踪后端接口 | [`backend/src/README.md`](backend/src/README.md) |
| 改前端代码 | [`frontend/AGENTS.md`](frontend/AGENTS.md) + [`frontend/docs/standards/`](frontend/docs/standards/) |
| 改设计系统 | [`design-system/AGENTS.md`](design-system/AGENTS.md) |
| 了解后端架构 | [`docs/design/backend/architecture.md`](docs/design/backend/architecture.md) |
| 了解技术选型理由 | [`backend/STACK.md`](backend/STACK.md) |

完整文档导航见 [`docs/README.md`](docs/README.md)。

## API 契约（硬性红线）

[`api-contract/`](api-contract/) 是 HTTP/SSE 机器契约的唯一事实来源，前后端都只能通过包
`@red-bean/api-contract` 消费，禁止前端从 `backend/src` 导入类型。[`docs/contracts/api.md`](docs/contracts/api.md)
是面向人工审查的语义说明和示例投影，不再定义机器类型。

- 改接口时先修改共享包中的 DTO、`routes.ts`、`error-codes.ts` 或 `validators.ts`，再同步生产者、
  消费者、契约测试和 `docs/contracts/api.md`。
- `api-contract/src/<domain>/dto.ts` 只放纯数据类型；函数、Schema、守卫、归一化和映射必须分别放入
  validator、parser、presenter 或 application service。
- 前后端 package 构建前必须先构建共享契约；统一入口为 `make contract-verify` 和 `make verify`。

**路由路径单一来源（端点目录）**：

- 接口路径文本只允许出现在 `api-contract/src/routes.ts` 的 `API_ROUTES` 命名表；后端注册使用
  `bindRoute`（method/path 取自命名表，`authenticated` 与 `auth` 钩子强制绑定），前端一律通过
  `API_ROUTES` + `buildPath` 拼路径；后端与前端均不得手写路由路径字面量。
- 目录模板语法一律使用 Fastify 原生形式（`:param`、通配 `*`）；`{xxx}` 仅允许出现在文档/OpenAPI 展示投影。
- R1：同一父路径下，同一深度禁止静态段与参数段并存；静态段只能上提为顶层资源或下钻到 `:id` 之下，
  `make contract-verify` 的防撞检查会机械拦截。
- R2：不依赖具体 id 的跨资源/系统级查询不借集合前缀，一律上提为顶层资源。
- R3：id 参数值域限 uuid/数字，静态段用连字符名词复数，两类值域不重叠。

## 目录与边界

### 代码

```text
red-bean-nian-gao/
├── api-contract/      前后端共享的可执行 API 契约（DTO、路由、错误码、运行时校验）
├── backend/          TypeScript 后端服务（Fastify + PostgreSQL + Redis + MinIO）
├── frontend/         React 前端（Vite + Tailwind CSS + Base UI）
├── design-system/    Design System 展示站点（Quiet Tool UI，Light / Dark 对等）
├── skills/           编码规范与开发流程的规则本体（见「Skill」节）
└── docs/             契约、设计、指南、标准与冻结记录
```

后端产品展示模型、会话聚合与仓储契约位于 `backend/src/modules/agent`——这些契约属于宿主，
**不得重新放回 Runtime SDK**。产品本身即 Harness：每个后端实例在启动期完成依赖组装，此后的能力图
保持固定。运行中的实例不安装 Provider、重建能力图或切换 Generation。

产品仓与 `red-bean-qing-tuan` Runtime 仓库按同级目录协作。`runtime.lock` 记录产品已验证的 Runtime
精确 commit；提交产品变更前，`make verify` 会确认 sibling Runtime 位于该 commit 且工作区干净。

### 文档

| 分类 | 目录 | 生命周期 |
| --- | --- | --- |
| 设计 | `docs/design/` 及模块内设计站 | 活文档；描述**当前**架构、模块行为与 UI 规范；不写进度与排期 |
| 契约 | `docs/contracts/` | 活文档；描述当前 HTTP、SSE 与跨模块接口 |
| 指南 | `docs/guides/` 及各模块 README | 活文档；描述当前安装、迁移、部署与操作方式 |
| 标准 | 模块 `docs/standards/` | 活文档；描述当前编码、测试和开发流程 |
| 计划 | `docs/plans/` 及模块同名目录 | 任务文档；执行期可修订，交付后冻结 |
| 决策记录 | `docs/decisions/` | 冻结；只追加不修改 |

根 `docs/standards/` 的三份是**短指针**——规则实体在 `skills/`。完整导航见 [`docs/README.md`](docs/README.md)。

## Skill

规则本体住在 Skill 里。`skills/` 是**唯一源**；`.claude/skills/` 与 `.agents/skills/` 只通过
符号链接暴露给对应客户端，**不复制规则正文**。

| Skill | 装什么 |
| --- | --- |
| [`red-bean-nian-gao-coding-conventions`](skills/red-bean-nian-gao-coding-conventions/SKILL.md) | 编码规范（本仓落点 + 通用件） |
| [`red-bean-nian-gao-development-workflow`](skills/red-bean-nian-gao-development-workflow/SKILL.md) | 开发流程（本仓落点 + 通用件） |
| [`design-system-visual-review`](skills/design-system-visual-review/SKILL.md) | 视觉评审专项工作流 |
| [`make-agent-system-tools`](skills/make-agent-system-tools/SKILL.md) | 后端 `sys_*` 系统工具专项工作流 |

前两个都**自包含**：规则正文在自己的目录里，不依赖本文件才能读懂。Skill 按任务自动触发；
本文件的路由是另一条到达路径。**Skill 不替代 `AGENTS.md`**，出现冲突时以离目标路径最近的
`AGENTS.md` 为准。`make docs-check` 校验 Skill 的 frontmatter 格式与「客户端目录必须是符号链接」
这两条机械事实。

## 决策权限

- **必须询问**：破坏公开兼容性的 API 变更、不可逆数据操作、产生外部成本或副作用、计划外的新生产依赖，
  以及改变尚未获批的安全边界。
- **告知后继续**：已批准 plan 内的兼容性接口扩展、可逆跨模块重构和 migration。
- **自主执行**：已批准范围内的实现、测试、文档同步和本地验证；不要对同一已批准决策重复询问。
- **提交与分支**：commit message 用中文、格式 `<type>: <简短描述>`（`feat:` / `fix:` / `refactor:`
  / `docs:` / `polish:`）；分支命名 `feat/<描述>`、`fix/<描述>`，kebab-case。
- commit、push、merge、发布及其他外部写入**只在用户明确授权时执行**；完成本地实现与验证不等于
  自动获得这些权限。

## 文档影响门禁

每次代码、配置、依赖或目录结构改动完成后，提交前必须查看完整 diff 并完成文档影响审查。阶段 5
可以不修改文档，但不能跳过审查；结论为“无需更新”时，交付说明必须写明理由。

审查必须从 [`docs/README.md`](docs/README.md) 的活文档索引开始，但不能停在索引页：按改动类型
打开索引中所有相关 contract、design、guide、standard 及模块入口，逐份判断是否需要更新。

| 改动类型 | 必须检查的权威文档 |
| --- | --- |
| 架构、模块边界、目录职责、依赖方向或开发门禁 | 根目录或模块 `AGENTS.md`、`docs/design/` 与对应 workflow 文档 |
| 安装、启动、配置、环境变量或用户命令 | `README.md` 及 `docs/guides/` 对应文档 |
| HTTP、SSE、存储结构或公开接口 | `docs/contracts/` 及相关设计文档 |
| UI 组件、布局、交互或 design token | Design System 的 Foundation、Showcase、可下载规范及相关 spec |
| Runtime SDK 的公开行为或接入方式 | Runtime README、TypeScript 入口、示例、migration 与兼容性说明 |
| 文档新增、删除、移动、重命名或分类变化 | `docs/README.md`、受影响索引项及所有引用该文档的活文档 |

`make docs-check` 校验活文档是否被索引、Markdown 本地链接、Skill 声明及跨客户端符号链接等机械事实；
通过不代表被索引文档的语义已经同步。

---

## 项目概述

red-bean-nian-gao 是一个 AI Agent 对话平台，支持流式对话、工具调用、子 Agent 委派和定时任务调度。

产品展示模型、会话聚合与仓储契约位于 `backend/src/modules/agent`。默认观测适配器位于
`backend/src/infra/observability`，业务代码只依赖中性 Tracer/Decorator 边界。LLM 实现由
`backend/src/platform/llm` 的启动期封闭 Registry 以静态 Provider 插件注册，Agent Loader 只接收
Runtime SDK 的中性 `LLMAdapterFactory`，不得直接选择具体 Provider 实现。工具能力同样由
`backend/src/platform/tool` 的静态 Provider 插件组装；工具注册与 Agent 默认授权是两个独立决策，
Agent Loader 只依赖只读 Tool Catalog。

后端进程的依赖图、HTTP 服务、后台任务和资源关闭集中在 `backend/src/app`；
`backend/src/entrypoint/server.main.ts` 只负责信号、配置和启动调用。`src/app/composition-root.ts`
是显式组装层，不是运行期 Service Locator，业务模块仍只通过构造函数接收依赖。
