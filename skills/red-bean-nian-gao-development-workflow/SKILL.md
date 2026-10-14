---
name: red-bean-nian-gao-development-workflow
description: 在 red-bean-nian-gao 中开发、修复、重构、评审、测试或交付代码时使用；给出本仓（含四个 workspace）的流程落点与必读顺序，并指向跨仓共享的开发流程规则。
---

# red-bean-nian-gao 开发流程

> 本 Skill 是本仓**开发流程的唯一事实来源**。
> 通用流程（一次开发的产出 plan / decision / design 及触发判据、三条红线、各自骨架、验收条件去向、
> 变更分级、六阶段、执行纪律、文档影响审查、交付核验）在
> [`references/common.md`](references/common.md)——与 Runtime SDK 仓 `red-bean-qing-tuan` 中的同名
> 文件**逐字相同**，由 `scripts/check-shared-files.mjs` 校验。本文件只写本仓特有的流程落点。

**开始任务前完整读取两份**：本文件 + [`references/common.md`](references/common.md)。

## 本仓特有的流程落点

本仓有四个 workspace，各自特有的流程与测试分层写在：

| workspace | 流程落点 |
| --- | --- |
| 后端 | [`backend/docs/standards/development-workflow.md`](../../backend/docs/standards/development-workflow.md) |
| 前端 | [`frontend/docs/standards/development-workflow.md`](../../frontend/docs/standards/development-workflow.md) |
| Design System | [`design-system/AGENTS.md`](../../design-system/AGENTS.md)「开发流程（硬性红线）」 |
| api-contract | 随前后端一起改；契约测试见根 [`AGENTS.md`](../../AGENTS.md)「API 契约（硬性红线）」 |

- **plan 的落点**：跨 workspace 落仓库根 `docs/plans/<date>-<feature>.md`；仅影响单个 workspace 时
  落 `backend/docs/plans/` 或 `frontend/docs/plans/`。
- **模块级 vs 非模块级**：新增 engine 模块、修改跨模块公开接口、新增 migration、新增 API 端点、
  新增外部依赖属模块级，必须走完六阶段。
- **交付前跑一条 `make verify`**，它会依次跑四个 workspace 的验证；逐项清单见
  [`../red-bean-nian-gao-coding-conventions/SKILL.md`](../red-bean-nian-gao-coding-conventions/SKILL.md)「门禁」。
- **改 Runtime SDK 的公开行为或接入方式**时，本仓按 `runtime.lock` 消费它：先改 SDK 仓并提交，
  本仓 bump lock 时逐字比对会强制同步。

## 测试先行分层（本仓特有）

| 改动类型 | 测试要求 |
| --- | --- |
| Bug 修复 | 能自动复现时，先添加失败的回归测试并确认失败原因正确 |
| TypeScript 后端、前端 hooks / store / service / utils | 严格执行 Red → Green → Refactor |
| React 组件交互 | 先列出状态与交互验收场景；可自动化的行为先写失败测试再实现。允许先搭结构或样式骨架，测试在功能完成前补齐 |
| 纯视觉样式、动画、Design System 探索 | 先定义 Showcase 状态与视觉验收条件，通过 Light/Dark、必要视口与人工目视验证；不强行为颜色或像素写脆弱单测 |
| 纯文档、配置、生成文件、机械接线 | 可以不先写测试，但必须说明原因并执行最接近风险的静态、构建、契约或手工验证 |

TDD 约束的是**行为增量**，不要求为每一行实现代码单独写测试。重构应在已有测试保持绿色的前提下进行。
