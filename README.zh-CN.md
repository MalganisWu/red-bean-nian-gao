<div align="center">

# Red Bean · 年糕

**AI Agent 对话平台。** 流式对话、工具调用、子 Agent 委派、定时任务，以及每一次运行的完整审计轨迹 ——
构建在一个可嵌入到任何宿主里的运行时 SDK 之上。

[![CI](https://github.com/cuteVanilla12138/red-bean-nian-gao/actions/workflows/ci.yml/badge.svg)](https://github.com/cuteVanilla12138/red-bean-nian-gao/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.9.0%20%3C26-brightgreen)](package.json)

英文版见 [README.md](README.md)。

</div>

![Red Bean 的一次会话：推理步骤、工具调用与子 Agent 委派](docs/assets/conversation.png)

## 为什么做这个

大多数 Agent 框架会慢慢长出长尾：这里一个聊天界面、那里一个数据库适配器、再加一个 HTTP 服务 ——
直到这个「框架」实际上变成一个应用。这既让 Agent 循环很难被嵌入到别处，也让人更难判断一个正在运行的
Agent 究竟被允许做什么。

Red Bean 把问题拆成两半：

- **[`red-bean-qing-tuan`](https://github.com/cuteVanilla12138/red-bean-qing-tuan)** —— 可嵌入的 TypeScript
  运行时 SDK。它负责 Agent 循环、checkpoint、interrupt 和一层厂商中性的观测接缝，对 HTTP、数据库和 UI
  一无所知。
- **本仓库** —— 产品侧。负责会话、持久化、认证、HTTP/SSE 接口、定时任务和设计系统。

由此带来三件值得说明的事：

1. **能力图在启动期固定。** 每个后端实例在启动时组装 runtime、观测适配器、LLM Provider 与工具 Catalog，
   运行期间不再安装或替换能力。一个实例能做什么是**一次决定**的，而不是逐请求协商的。
2. **每一次运行都可审计。** 运行被记录进 append-only 的事实日志，并以只读轨迹视图呈现：跑了哪些工具、
   每一步耗时多久、每次请求花了多少 token。
3. **Runtime 像依赖一样被版本化。** `runtime.lock` 把 SDK 钉在确切的 commit 上；`make verify` 会拒绝
   在版本不匹配或有未提交改动的工作区上运行。

## 功能

| 能力 | 说明 |
| --- | --- |
| **流式对话** | SSE 流式输出，含推理块；过程时间线会把冗长的工具序列折叠成可读摘要。 |
| **工具调用** | 静态 `sys_*` 工具集 —— 文件读写、glob、grep、HTTP、时间、待办 —— 启动期注册，按 Agent 授权。 |
| **子 Agent 委派** | 父运行可以把工作交给子 Agent，并把子执行的进展折叠进自己的时间线。 |
| **中断与恢复** | 任意工具都可以挂起运行以请求人工确认。interrupt 是执行屏障：确认到达前，同批其他工具不会执行。 |
| **定时任务** | cron 驱动的运行，带重试策略、投递队列和独立的执行历史。 |
| **会话轨迹** | 基于运行事实日志的只读审计视图，含每次请求的 token 与耗时核算。 |
| **设计系统** | Light/Dark 对等的组件库，随一个可运行的展示站一起交付。 |

![定时任务：任务定义、计划与最近一次运行并排呈现](docs/assets/scheduled-tasks.png)

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

四个 workspace 包加上同级的 SDK：

- **`api-contract/`** —— HTTP 路由、SSE 事件、DTO、错误码与运行时校验的机器可执行唯一来源。前后端都依赖它，
  任何一侧都不重新声明形状。
- **`backend/`** —— Fastify、显式 SQL 的 `pg`、一个在启动时一次性完成装配的 composition root，以及
  `agent` / `task` / `identity` / `storage` / `system` 各模块 —— 模块之间依赖 Port，而不是互相依赖。
- **`frontend/`** —— React 19 + Vite，消费契约与设计系统。
- **`design-system/`** —— Quiet Tool UI 组件库，附一个把每个组件在两种主题下都渲染出来的展示站。
  漂移检查会在「前端 import 了不存在的组件」或「公开组件没有 showcase 页」时直接让构建失败。

后端只通过单一的 `AgentExecutionPort` 触达运行时 SDK。普通聊天、定时任务与子 Agent 共用同一个执行器，
区别只在于各自的产品生命周期。

## 快速开始

**前置要求：** Node.js `>=24.9.0 <26`、pnpm 11.x、Docker。执行 `make doctor` 可一次检查全部。

```bash
git clone https://github.com/cuteVanilla12138/red-bean-nian-gao.git
cd red-bean-nian-gao
make init                # 工具链 · 锁定的 Runtime SDK · workspace 依赖 · backend/.env.local

# 填写数据库/Redis/MinIO 密码、JWT secret 与 LLM key
$EDITOR backend/.env.local

make infra-up && make db-migrate
make run                     # 后端 → http://localhost:8080
pnpm --filter frontend dev   # 前端 → http://localhost:5173
```

`make init` 是唯一的一键入口：检查工具链、把 Runtime SDK 克隆到本仓同级、切到 `runtime.lock`
锁定的 revision 并构建它、安装 workspace 依赖，并把 `backend/.env.local.example` 复制到位。
**它从不覆盖已存在的 `.env.local`，重复执行是安全的。**

`make bootstrap` 会把 SDK 克隆到名为 `red-bean-qing-tuan` 的同级目录 —— 后端通过相对路径
`link:../../red-bean-qing-tuan` 消费它，**目录名是硬约束，GitHub 仓库名则不是**。重复执行是安全的：
已经正确的检出与构建不会被重复劳动。若你把 SDK 放在别处，传 `SDK_DIR=<路径>`。

设计系统展示站同理，且不需要后端、不需要 LLM key：

```bash
pnpm --filter design-system dev   # → http://localhost:5174
```

## 质量门禁

全部在本地离线运行，不依赖任何外部服务。

```bash
make doctor         # 工具链版本与 package 声明检查
make docs-check     # 活文档索引、Markdown 链接与跨客户端 Skill 单一来源
make secrets-check  # 环境文件忽略策略与高置信度密钥检查
make fmt            # 改写文件（这是修复命令）
make verify         # 后端 + 前端 + 设计系统 + 契约 + 文档 + 同级 SDK
make verify-full    # 额外要求真实基础设施集成测试与依赖审计
```

`make verify` 覆盖四个包与锁定的 SDK。`make fmt` 是唯一会写跟踪文件的命令。

可选的 Git hooks，按仓显式安装（从不自动装）：

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
- [`docs/design/backend/architecture.md`](docs/design/backend/architecture.md) —— 后端分层与依赖方向
- [`docs/design/agent/pipeline.md`](docs/design/agent/pipeline.md) —— 主会话 Pipeline 与 Hook
- [`docs/design/session/session-trajectory.md`](docs/design/session/session-trajectory.md) —— 轨迹审计视图的信息架构
- [`docs/decisions/`](docs/decisions/) —— ADR：选了什么、代价是什么、排除了什么
- [`backend/STACK.md`](backend/STACK.md) —— 后端技术选型与理由
- [`AGENTS.md`](AGENTS.md) —— 本仓遵循的开发规范

## Runtime 是独立的仓库

Agent 循环、checkpoint 语义、interrupt 屏障与工具安全策略都在
[`red-bean-qing-tuan`](https://github.com/cuteVanilla12138/red-bean-qing-tuan) 里。这个拆分是刻意的：
Runtime 零生产依赖、对这个产品一无所知，因此可以被嵌进 CLI 或完全不同的宿主。

两个仓只通过 `runtime.lock` 耦合。升级流程：先在 SDK 仓提交，再更新本仓的 lock 文件并运行 `make verify`。

## License

[MIT](LICENSE)
