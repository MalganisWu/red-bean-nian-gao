<div align="center">

# Red Bean · 年糕

[![CI](https://github.com/MalganisWu/red-bean-nian-gao/actions/workflows/ci.yml/badge.svg)](https://github.com/MalganisWu/red-bean-nian-gao/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D24.9.0%20%3C26-brightgreen)

</div>

<details name="lang">
<summary>English</summary>

**An AI agent chat platform.** Streaming conversations, tool calling, sub-agent delegation,
scheduled tasks, and a full audit trail for every run — built on a runtime SDK that can be
embedded anywhere.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/conversation-dark.png">
  <img alt="A Red Bean conversation: reasoning steps, tool calls, and a delegated sub-agent" src="docs/assets/conversation.png">
</picture>

## Why this exists

Most agent frameworks grow a long tail — a chat UI here, a database adapter there, an HTTP
server somewhere — until the "framework" is really an application. That makes the agent loop
hard to embed in anything else, and harder still to reason about what a running agent is
actually permitted to do.

Red Bean splits the problem in two:

- **[`red-bean-qing-tuan`](https://github.com/MalganisWu/red-bean-qing-tuan)** — an embeddable
  TypeScript runtime SDK. It owns the agent loop, checkpointing, interrupts, and a
  vendor-neutral observability seam. It knows nothing about HTTP, databases, or UI.
- **This repository** — the product. It owns sessions, persistence, authentication, the
  HTTP/SSE surface, scheduled tasks, and the design system.

Three consequences worth calling out:

1. **The capability graph is fixed at boot.** Each backend instance assembles its runtime,
   observability adapters, LLM providers, and tool catalog at startup, and never installs or
   replaces capabilities while running. What an instance can do is decided once, not
   negotiated per request.
2. **Every run is auditable.** Runs are recorded to an append-only fact log and surfaced in a
   read-only trajectory view: which tools ran, how long each step took, how many tokens each
   request cost.
3. **The runtime is versioned like a dependency.** `runtime.lock` pins the SDK to an exact
   commit; `make verify` refuses to run against a mismatched or dirty working tree.

## Features

| Feature | What it does |
| --- | --- |
| **Streaming conversations** | Server-sent events with reasoning blocks and a process timeline that folds long tool sequences into a readable summary. |
| **Tool calling** | A static `sys_*` catalog — file read/write, glob, grep, HTTP, time, todos — registered at boot and authorized per agent. |
| **Sub-agent delegation** | A parent run hands work to a child agent and folds the child's progress into its own timeline. |
| **Interrupt & resume** | Any tool can suspend a run to ask a human. The interrupt is an execution barrier: no other tool in the batch runs before the answer arrives. |
| **Scheduled tasks** | Cron-driven runs with retry policy, a delivery queue, and their own execution history. |
| **Session trajectory** | A read-only audit view over the run fact log, with per-request token accounting and timing. |
| **Design system** | A component library with Light/Dark parity, shipped as a runnable showcase site. |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/scheduled-tasks-dark.png">
  <img alt="Scheduled tasks: definitions, plans, and the latest run side by side" src="docs/assets/scheduled-tasks.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-run-dark.png">
  <img alt="A scheduled run: the automatic execution is folded into the same timeline reading as a conversation" src="docs/assets/task-run.png">
</picture>

## Architecture

```text
┌─────────────┐   HTTP / SSE    ┌──────────────┐   AgentExecutionPort   ┌──────────────────────┐
│  frontend   │ ──────────────▶ │   backend    │ ─────────────────────▶ │  red-bean-qing-tuan  │
│ React + Vite│ ◀────────────── │   Fastify    │ ◀───────────────────── │  (runtime SDK)       │
└─────────────┘                 └──────┬───────┘   pinned by runtime.lock└──────────────────────┘
                                       │
       ┌───────────────┬───────────────┼───────────────┬───────────────┐
       ▼               ▼               ▼               ▼               ▼
  PostgreSQL        Redis           MinIO       api-contract    design-system
  (sessions,      (buffers,      (objects,     (shared DTOs,   (Quiet Tool UI,
   run facts,      locks)         uploads)      routes, codes)  Light/Dark)
   tasks)
```

Four workspace packages plus the sibling SDK:

- **`api-contract/`** — the machine-executable source of truth for HTTP routes, SSE events,
  DTOs, error codes, and runtime validation. Both frontend and backend depend on it; neither
  re-declares its shapes.
- **`backend/`** — Fastify, `pg` with explicit SQL, a composition root that wires everything
  once at boot, and modules (`agent`, `task`, `identity`, `storage`, `system`) that depend on
  ports rather than each other.
- **`frontend/`** — React 19 + Vite. Consumes the contract and the design system.
- **`design-system/`** — the Quiet Tool UI component library, with a showcase site that
  renders every component in both themes. A drift check fails the build if the frontend
  imports a component that doesn't exist, or if a public component has no showcase page.

The backend reaches the runtime SDK through a single `AgentExecutionPort`. Ordinary chat,
scheduled tasks, and sub-agents all share one executor and differ only in their product
lifecycle.

## Quick start

**Prerequisites:** Node.js `>=24.9.0 <26`, pnpm 11.x, Docker. Run `make doctor` to check all
of them at once.

```bash
git clone https://github.com/MalganisWu/red-bean-nian-gao.git
cd red-bean-nian-gao
make init                # toolchain · pinned runtime SDK · workspace deps · backend/.env.local

# fill in database/Redis/MinIO passwords, a JWT secret, and an LLM key
$EDITOR backend/.env.local

make infra-up && make db-migrate
make run                     # backend  → http://localhost:8080
pnpm --filter frontend dev   # frontend → http://localhost:5173
```

Or start both with one command; **when either exits, both are cleaned up**, so nothing is left
holding port 8080:

```bash
make full-dev                # backend 8080 + frontend 5173
```

`make init` is the one-shot entry point: it checks the toolchain, clones the runtime SDK
alongside this repository, checks out the revision pinned in `runtime.lock`, builds it, installs
the workspace, and copies `backend/.env.local.example` into place. It never overwrites an
existing `.env.local`, and re-running it is safe.

`make bootstrap` clones the SDK into a sibling directory named `red-bean-qing-tuan`, because the
backend consumes it through the relative link `link:../../red-bean-qing-tuan`. The directory name
is load-bearing; the GitHub repository name is not. Re-running it is safe: an already-correct
checkout and build are left alone. If you keep the SDK elsewhere, pass `SDK_DIR=<path>`.

The design system showcase runs the same way and needs neither the backend nor an LLM key:

```bash
pnpm --filter design-system dev   # → http://localhost:5174
```

## Quality gates

Everything runs locally and offline; no external services are required.

```bash
make doctor         # toolchain versions and package declarations
make docs-check     # living-doc index, markdown links, cross-client skill source
make secrets-check  # env ignore policy and high-confidence secret scan
make fmt            # rewrite files (this is the fixing command)
make verify         # backend + frontend + design system + contract + docs + sibling SDK
make verify-full    # adds real-infrastructure integration tests and a dependency audit
```

`make verify` covers four packages and the pinned SDK. `make fmt` is the only command that
writes to tracked files.

Optional Git hooks, installed per clone (they are never installed automatically):

```bash
make hooks-install   # pre-commit runs verify-quick, pre-push runs verify
```

## Project layout

```text
red-bean-nian-gao/
├── api-contract/     Shared API contract: DTOs, routes, error codes, validation
├── backend/          Fastify service: sessions, tasks, storage, agent execution
├── frontend/         React app: chat, trajectory audit, scheduled tasks
├── design-system/    Quiet Tool UI library and showcase site
├── docs/             Living design docs, ADRs, and the documentation index
├── runtime.lock      Pinned red-bean-qing-tuan revision
└── Makefile          Single task entry point
```

## Documentation

- [`docs/README.md`](docs/README.md) — index of all living docs and decision records
- [`docs/glossary.md`](docs/glossary.md) — terminology: the terms easiest to mistake for ones you already know, including the front/back split and their runtime-contract counterparts
- [`docs/design/backend/architecture.md`](docs/design/backend/architecture.md) — layering and dependency direction
- [`docs/design/agent/pipeline.md`](docs/design/agent/pipeline.md) — the main session pipeline and hooks
- [`docs/design/session/session-trajectory.md`](docs/design/session/session-trajectory.md) — the audit view's information architecture
- [`docs/decisions/`](docs/decisions/) — decision records: what was chosen, what it cost, what it rules out
- [`backend/STACK.md`](backend/STACK.md) — backend technology choices and the reasoning behind them
- [`AGENTS.md`](AGENTS.md) — the development conventions this repository is held to

## The runtime is a separate repository

The agent loop, checkpoint semantics, interrupt barriers, and tool safety policy live in
[`red-bean-qing-tuan`](https://github.com/MalganisWu/red-bean-qing-tuan). That split is
deliberate: the runtime has no production dependencies and no knowledge of this product, so
it can be embedded in a CLI or a different host entirely.

The two repositories are coupled only by `runtime.lock`. To upgrade: commit in the SDK, then
update the lock file here and run `make verify`.

## License

[MIT](LICENSE)

</details>

<details name="lang" open>
<summary>简体中文</summary>

**一个 AI Agent 对话平台。** 支持流式对话、工具调用、子 Agent 委派、定时任务，并为每次运行留下完整审计轨迹。
底层是一个可以嵌进任何宿主的运行时 SDK。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/conversation-dark.png">
  <img alt="Red Bean 的一次会话：推理步骤、工具调用与子 Agent 委派" src="docs/assets/conversation.png">
</picture>

## 为什么会有 Red Bean

很多 Agent 框架会顺着需求一直长：这里加个聊天界面，那里加个数据库适配器，再补一个 HTTP 服务——
长到最后，这个「框架」其实已经是个应用了。结果就是 Agent 循环很难嵌到别处去用；一个正在跑的 Agent
到底能做什么，也变得越来越难看清。

Red Bean 的做法是把问题拆成两半：

- **[`red-bean-qing-tuan`](https://github.com/MalganisWu/red-bean-qing-tuan)** —— 可嵌入的 TypeScript
  运行时 SDK。它负责 Agent 循环、checkpoint、interrupt 和一层与厂商无关的观测接缝，对 HTTP、数据库
  和 UI 一无所知。
- **本仓库** —— 产品侧。负责会话、持久化、认证、HTTP/SSE 接口、定时任务和设计系统。

这么拆带来三个结果：

1. **能力图在启动时就定死。** 每个后端实例在启动时把 runtime、观测适配器、LLM Provider 和工具
   Catalog 组装好，运行期间不再增删或替换。一个实例能做什么，启动那一刻就决定了，不会每个请求再变。
2. **每次运行都能追溯。** 运行会写进一份只追加的事实日志，再以只读的轨迹视图呈现出来：跑过哪些工具、
   每一步花了多久、每次请求用掉多少 token。
3. **Runtime 当成依赖来管版本。** `runtime.lock` 把 SDK 钉死在确切的 commit 上；版本对不上、或者
   工作区有未提交改动时，`make verify` 会直接拒绝运行。

## 功能

| 能力 | 说明 |
| --- | --- |
| **流式对话** | SSE 流式输出，带推理块；过程时间线会把一长串工具调用折叠成易读的摘要。 |
| **工具调用** | `sys_*` 静态工具集——文件读写、glob、grep、HTTP、时间、待办——启动时注册，再按 Agent 逐个授权。 |
| **子 Agent 委派** | 父运行可以把活派给子 Agent，子执行的进展会折叠进父运行自己的时间线。 |
| **中断与恢复** | 任何工具都能挂起运行、要求人工确认。interrupt 是执行屏障：确认没到之前，同批的其他工具一律不执行。 |
| **定时任务** | 由 cron 触发的运行，带重试策略、投递队列，以及独立的执行历史。 |
| **会话轨迹** | 基于运行事实日志的只读审计视图，按请求统计 token 与耗时。 |
| **设计系统** | 明暗两套主题对等的组件库，附一个可以直接跑起来的展示站。 |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/scheduled-tasks-dark.png">
  <img alt="定时任务：任务定义、计划与最近一次运行并排呈现" src="docs/assets/scheduled-tasks.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-run-dark.png">
  <img alt="一次定时运行：自动执行的过程同样折叠成与对话一致的阅读方式" src="docs/assets/task-run.png">
</picture>

## 架构

```text
┌─────────────┐   HTTP / SSE    ┌──────────────┐   AgentExecutionPort   ┌──────────────────────┐
│  frontend   │ ──────────────▶ │   backend    │ ─────────────────────▶ │  red-bean-qing-tuan  │
│ React + Vite│ ◀────────────── │   Fastify    │ ◀───────────────────── │  (运行时 SDK)         │
└─────────────┘                 └──────┬───────┘  由 runtime.lock 钉住   └──────────────────────┘
                                       │
       ┌───────────────┬───────────────┼───────────────┬───────────────┐
       ▼               ▼               ▼               ▼               ▼
  PostgreSQL        Redis           MinIO       api-contract    design-system
  (会话、运行        (缓冲、         (对象、       (共享 DTO、      (Quiet Tool UI,
   事实、任务)       锁)             上传)        路由、错误码)    Light/Dark)
```

四个 workspace 包，加上同级的 SDK：

- **`api-contract/`** —— HTTP 路由、SSE 事件、DTO、错误码和运行时校验的唯一事实来源，而且是机器可执行的。
  前后端都依赖它，谁也不用再各写一份。
- **`backend/`** —— Fastify、直接写 SQL 的 `pg`、启动时一次性完成装配的 composition root，以及
  `agent` / `task` / `identity` / `storage` / `system` 各模块——模块之间依赖 Port，而不是互相依赖。
- **`frontend/`** —— React 19 + Vite，消费契约和设计系统。
- **`design-system/`** —— Quiet Tool UI 组件库，附一个展示站，把每个组件在明暗两种主题下都渲染一遍。
  漂移检查会让构建直接失败：只要前端 import 了不存在的组件，或者某个公开组件没有对应的展示页。

后端只通过一个入口碰运行时 SDK：`AgentExecutionPort`。普通聊天、定时任务和子 Agent 共用同一个执行器，
区别只在各自的产品生命周期。

## 快速开始

**环境要求：** Node.js `>=24.9.0 <26`、pnpm 11.x、Docker。跑一次 `make doctor` 可以全部检查。

```bash
git clone https://github.com/MalganisWu/red-bean-nian-gao.git
cd red-bean-nian-gao
make init                # 工具链 · 锁定的 Runtime SDK · workspace 依赖 · backend/.env.local

# 填写数据库/Redis/MinIO 密码、JWT secret 与 LLM key
$EDITOR backend/.env.local

make infra-up && make db-migrate
make run                     # 后端 → http://localhost:8080
pnpm --filter frontend dev   # 前端 → http://localhost:5173
```

或者一条命令同时起两个；**任一退出时两个都会清理**，不会留下占着 8080 的后端：

```bash
make full-dev                # 后端 8080 + 前端 5173
```

`make init` 是唯一的一键入口，它依次做四件事：检查工具链 → 把 Runtime SDK 克隆到本仓同级目录、切到
`runtime.lock` 锁定的 revision 并构建 → 安装 workspace 依赖 → 把 `backend/.env.local.example`
复制到位。**它不会覆盖已有的 `.env.local`，重复跑也没问题。**

`make bootstrap` 会把 SDK 克隆到名为 `red-bean-qing-tuan` 的同级目录——后端是通过相对路径
`link:../../red-bean-qing-tuan` 引用它的，**所以这个目录名不能改，GitHub 上的仓库名倒是随意**。
重复跑也没问题：已经就绪的检出和构建不会白做一遍。SDK 放在别处的话，传 `SDK_DIR=<路径>`。

设计系统展示站的跑法一样，而且不需要后端，也不需要 LLM key：

```bash
pnpm --filter design-system dev   # → http://localhost:5174
```

## 质量门禁

以下全部在本地离线运行，不需要任何外部服务。

```bash
make doctor         # 工具链版本与 package 声明检查
make docs-check     # 活文档索引、Markdown 链接与跨客户端 Skill 单一来源
make secrets-check  # 环境文件忽略策略与高置信度密钥检查
make fmt            # 改写文件（这是修复命令）
make verify         # 后端 + 前端 + 设计系统 + 契约 + 文档 + 同级 SDK
make verify-full    # 额外要求真实基础设施集成测试与依赖审计
```

`make verify` 覆盖四个包和锁定的 SDK。`make fmt` 是唯一会改写被跟踪文件的命令。

Git hooks 是可选的，需要按仓手动安装（永远不会自动装）：

```bash
make hooks-install   # pre-commit 跑 verify-quick，pre-push 跑 verify
```

## 目录结构

```text
red-bean-nian-gao/
├── api-contract/     前后端共享契约：DTO、路由、错误码、运行时校验
├── backend/          Fastify 服务：会话、任务、存储与 Agent 执行
├── frontend/         React 应用：对话、轨迹审计、定时任务
├── design-system/    Quiet Tool UI 组件库与展示站
├── docs/             活文档、ADR 决策记录与文档索引
├── runtime.lock      锁定的 red-bean-qing-tuan revision
└── Makefile          统一任务入口
```

## 文档

- [`docs/README.md`](docs/README.md) —— 全部活文档与决策记录的索引
- [`docs/glossary.md`](docs/glossary.md) —— 术语表：读代码时最容易「以为自己认识」的词，含前后端分工与与 Runtime 契约词的对照
- [`docs/design/backend/architecture.md`](docs/design/backend/architecture.md) —— 后端分层与依赖方向
- [`docs/design/agent/pipeline.md`](docs/design/agent/pipeline.md) —— 主会话 Pipeline 与 Hook
- [`docs/design/session/session-trajectory.md`](docs/design/session/session-trajectory.md) —— 轨迹审计视图的信息架构
- [`docs/decisions/`](docs/decisions/) —— 决策记录：选了什么、代价是什么、排除了什么
- [`backend/STACK.md`](backend/STACK.md) —— 后端技术选型与理由
- [`AGENTS.md`](AGENTS.md) —— 本仓遵循的开发规范

## Runtime 为什么单独开一个仓

Agent 循环、checkpoint 语义、interrupt 屏障和工具安全策略都在
[`red-bean-qing-tuan`](https://github.com/MalganisWu/red-bean-qing-tuan) 里。这样拆是有意为之：
Runtime 没有任何生产依赖，也完全不知道这个产品的存在，所以它能嵌进 CLI，或者别的完全不同的宿主。

两个仓只通过 `runtime.lock` 耦合。升级流程：先在 SDK 仓提交，再更新本仓的 lock 文件，然后跑 `make verify`。

## License

[MIT](LICENSE)

</details>
