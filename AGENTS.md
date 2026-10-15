# AGENTS.md

AI 开发助手入口。本文件是**治理入口**：项目边界、路由、协作权限与命令。
**编码规范与开发流程的规则本体在 Skill 里**，本文件只做路由，见「[编码规范](#编码规范)」与
「[开发与测试流程](#开发与测试流程)」两节。

---

## 开始任务

1. 完整读取本文件（根 `AGENTS.md`）。
2. 完整读取**四个 workspace 通用的开发流程 Skill**（见「[开发与测试流程](#开发与测试流程)」节）。
3. 按要改的代码，完整读取对应 workspace 的 `AGENTS.md`（见「[编码规范](#编码规范)」节）；它指向
   本 workspace 的编码规范 Skill。规则冲突时以离目标文件最近者为准。
4. 检查工作区状态，保留用户已有改动；范围或权限不明确时先确认。

## 编码规范

**各 workspace 各不相同，所以根不承载正文**——先读该 workspace 的 `AGENTS.md`，再由它指向适用的
编码规范 Skill：

| workspace | 先读 |
| --- | --- |
| 后端 | [`backend/AGENTS.md`](backend/AGENTS.md) |
| api-contract | 本文件「[前后端共用契约包（硬性红线）](#前后端共用契约包硬性红线)」 |
| 前端 | [`frontend/AGENTS.md`](frontend/AGENTS.md) |
| 设计系统 | [`design-system/AGENTS.md`](design-system/AGENTS.md) |

## 开发与测试流程

**四个 workspace 通用，所以根直接指向 Skill**，不经过各级 `AGENTS.md`：

- [`skills/red-bean-nian-gao-development-workflow/SKILL.md`](skills/red-bean-nian-gao-development-workflow/SKILL.md)
  写本仓特有的流程落点（四个 workspace 的流程文档位置、plan 落点、模块级判定、UI 变更的 mock 先行）。
- 其 [`references/common.md`](skills/red-bean-nian-gao-development-workflow/references/common.md) 写
  **跨仓共享**的通用流程（一次开发的产出 plan / decision / design 及触发判据、三条红线、各自骨架、
  验收条件去向、变更分级、六阶段、执行纪律、文档影响审查、交付核验），与 Runtime SDK 仓逐字相同。

**其他入口**：人工追踪后端接口见
[`backend/src/README.md`](backend/src/README.md)；后端架构见
[`docs/design/backend/architecture.md`](docs/design/backend/architecture.md)；技术选型理由见
[`backend/STACK.md`](backend/STACK.md)；完整文档导航见 [`docs/README.md`](docs/README.md)。

## 前后端共用契约包（硬性红线）

[`api-contract/`](api-contract/) 是 HTTP/SSE 机器契约的唯一事实来源——**它是一段可直接 import 的
TypeScript 代码**（纯类型 + 同名 zod schema + 路由表 + 错误码），前端与后端共用同一个包
`@red-bean/api-contract`，不存在「按文档对齐」的第二份；禁止前端从 `backend/src` 导入类型。
[`docs/contracts/api.md`](docs/contracts/api.md) 只是面向人工审查的语义说明和示例投影，不再定义机器类型。

- 改接口时先修改共享包中的 DTO、`routes.ts`、`error-codes.ts` 或 `validators.ts`，再同步生产者、
  消费者、契约测试和 `docs/contracts/api.md`。
- `api-contract/src/<domain>/dto.ts` 只放纯数据类型；函数、Schema、守卫、归一化和映射必须分别放入
  validator、parser、presenter 或 application service。
- 前后端 package 构建前必须先构建共享契约；统一入口为 `make contract-verify` 和 `make verify`。

## 路由路径单一来源（硬性红线）

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
├── skills/           编码规范与开发流程的规则本体
└── docs/             契约、设计、指南、标准与冻结记录
```

产品仓与 `red-bean-qing-tuan` Runtime 仓库按同级目录协作。`runtime.lock` 记录产品已验证的 Runtime
精确 commit；提交产品变更前，`make verify` 会确认 sibling Runtime 位于该 commit 且工作区干净。
（只做前端的贡献者也需要同级 clone——`make verify` 的 `sdk-verify` 与 `shared-files-check` 会用到它。）
后端如何消费 Runtime 见 [`backend/AGENTS.md`](backend/AGENTS.md)。

### 文档

| 分类 | 目录 | 生命周期 |
| --- | --- | --- |
| 设计 | `docs/design/` 及模块内设计站 | 活文档；描述**当前**架构、模块行为与 UI 规范——面向产品功能；不写进度与排期，也不写代码书写规范（后者在 `standards/` 与 `skills/`） |
| 契约 | `docs/contracts/` | 活文档；描述当前 HTTP、SSE 与跨模块接口 |
| 指南 | `docs/guides/` 及各模块 README | 活文档；描述当前安装、迁移、部署与操作方式 |
| 标准 | 模块 `docs/standards/` | 活文档；描述当前编码、测试和开发流程 |
| 计划 | `docs/plans/` 及模块同名目录 | 任务文档；执行期可修订，交付后冻结 |
| 决策记录 | `docs/decisions/` | 冻结；只追加不修改 |

读代码遇到「以为自己认识」的词，先查 [`docs/glossary.md`](docs/glossary.md)（本仓术语表）——
它只写一句话定义与「不是……」的边界，是**读者索引**，不是第二个事实来源。

根 `docs/standards/` 的三份是**短指针**——规则实体在 `skills/`。完整导航见 [`docs/README.md`](docs/README.md)。

## 门禁

**本仓门禁命令的唯一清单就在这里**；其他文档只引用，不重列。`make verify` 依次执行：

```bash
make require-install       # 确认依赖已按 lockfile 安装
make doctor                # 工具链版本与 package 声明
make diff-check            # git diff 空白检查
make docs-check            # 文档索引与链接
make shared-files-check    # 跨仓共享件逐字一致
make secrets-check         # 环境文件与高置信度密钥扫描
make compose-check         # 本地 Compose 安全配置
make ts-policy-check       # TypeScript 政策
make ts-export-jsdoc-check # 注释门禁
make backend-verify        # 后端格式、类型、Lint、测试与构建
make frontend-verify       # 前端格式、类型、Lint、测试与构建
make ds-check              # Design System
make sdk-verify            # sibling Runtime SDK 与 runtime.lock 一致
```

`make verify*` 是只读检查。格式修复使用明确的写入命令；检查失败后不得用断言、disable 注释或降低
配置掩盖问题。

## Skill

规则本体住在 Skill 里，各级 `AGENTS.md` 指向适用的那一份。`skills/` 是**唯一源**，任何地方都
不复制规则正文。

**`.agents/skills/` 随仓走**——它是 [Agent Skills](https://agentskills.io) 的开放标准路径，多个
工具（Codex、OpenCode 等）从这里发现 Skill，仓库因此不偏向任何一家。其余是各家工具的私有目录
（`.claude/`、`.cursor/`、`.codex/` …），**一律不进库**；用哪个，自己在本地建符号链接指向
`skills/<name>` 即可。

Skill 按任务自动触发，本文件与各级 `AGENTS.md` 的路由是另一条到达路径。**Skill 不替代
`AGENTS.md`**，出现冲突时以离目标路径最近的 `AGENTS.md` 为准。`make docs-check` 校验 Skill 的
frontmatter 格式、「`name` 必须等于目录名」，以及 `.agents/skills/` 下每个 Skill 都是指向
`skills/<name>` 的符号链接。

## 决策权限

- **必须询问**：破坏公开兼容性的 API 变更、不可逆数据操作、产生外部成本或副作用、计划外的新生产依赖，
  以及改变尚未获批的安全边界。
- **告知后继续**：已批准 plan 内的兼容性接口扩展、可逆跨模块重构和 migration。
- **自主执行**：已批准范围内的实现、测试、文档同步和本地验证；不要对同一已批准决策重复询问。
- **提交与分支**：commit message 用中文、格式 `<type>: <简短描述>`（`feat:` / `fix:` / `refactor:`
  / `docs:` / `polish:`）；分支命名 `feat/<描述>`、`fix/<描述>`，kebab-case。
- commit、push、merge、发布及其他外部写入**只在用户明确授权时执行**；完成本地实现与验证不等于
  自动获得这些权限。

## 文档影响审查

每次代码、配置、依赖或目录结构改动完成后，提交前必须查看完整 diff 并完成文档影响审查。阶段 5
可以不修改文档，但不能跳过审查；结论为“无需更新”时，交付说明必须写明理由。

审查必须从 [`docs/README.md`](docs/README.md) 的活文档索引开始，但不能停在索引页：按改动类型
打开索引中所有相关 contract、design、guide、standard 及模块入口，逐份判断是否需要更新。

| 改动类型 | 必须检查的权威文档 |
| --- | --- |
| 架构、模块边界、目录职责、依赖方向或开发门禁 | 根目录或模块 `AGENTS.md`、`docs/design/` 与对应 workflow 文档 |
| 新增业务模块 | `docs/design/<module>/`、`backend/AGENTS.md` 与 `docs/README.md` |
| 新增产品工具或 LLM Provider | [`docs/design/tool/tool-system.md`](docs/design/tool/tool-system.md)、[`docs/design/agent/`](docs/design/agent/) 与 [`backend/STACK.md`](backend/STACK.md) |
| Session、lease 或 fence | [`docs/design/session/`](docs/design/session/) 与并发测试 |
| 可观测性（Trace、日志） | [`docs/design/backend/observability.md`](docs/design/backend/observability.md) 与 `docs/contracts/` |
| 启动期组装、Registry 或部署更新 | [`docs/design/infra/bootstrap.md`](docs/design/infra/bootstrap.md) 与 [`docs/design/backend/architecture.md`](docs/design/backend/architecture.md) |
| 安装、启动、配置、环境变量或用户命令 | `README.md` 及 `docs/guides/` 对应文档 |
| HTTP、SSE、存储结构或公开接口 | `docs/contracts/` 及相关设计文档 |
| UI 组件、布局、交互或 design token | Design System 的 Foundation、Showcase、可下载规范及相关 spec |
| Runtime SDK 的公开行为或接入方式 | Runtime README、TypeScript 入口、示例、migration 与兼容性说明 |
| 文档新增、删除、移动、重命名或分类变化 | `docs/README.md`、受影响索引项及所有引用该文档的活文档 |

`make docs-check` 校验活文档是否被索引、Markdown 本地链接、Skill 声明及跨客户端符号链接等机械事实；
通过不代表被索引文档的语义已经同步。

## 项目概述

red-bean-nian-gao 是一个 AI Agent 对话平台，支持流式对话、工具调用、子 Agent 委派和定时任务调度。
后端、前端、Design System 与 api-contract 四条线如何拼在一起，见各自的 `AGENTS.md` 与
[`docs/README.md`](docs/README.md)。
