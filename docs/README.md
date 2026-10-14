# 产品文档索引

本页只负责导航。文档分类、更新义务与交付规则以根目录 [`AGENTS.md`](../AGENTS.md) 为准。

> 2026-09-05 已按 TypeScript 后端生产入口完成语义复核。后续改动仍须沿本索引重新审查相关文档；
> “已复核”不是永久有效的状态。

代码、配置或目录发生变化时，先用本页确定受影响类别，再打开该类别下与改动相关的每份文档。
更新本索引只能证明导航完整，不能代替对链接目标的语义审查。

## 活文档

> 一次开发的产出只有 `plans/` / `decisions/` / `design/` 三样，触发判据与红线见
> [`standards/development-workflow.md`](standards/development-workflow.md)「一次开发的产出」。
> 本节索引**活文档**（描述当前事实）；`design/` 不写进度与排期。

### 契约、架构与运行

- [`../api-contract/src/`](../api-contract/src/)：前后端 HTTP/SSE 的机器可执行唯一契约源。
- [`contracts/api.md`](contracts/api.md)：HTTP、SSE 与错误码的人类语义说明和示例投影。
- [`design/backend/architecture.md`](design/backend/architecture.md)：后端架构、分层与依赖方向。
- [`design/backend/observability.md`](design/backend/observability.md)：请求、运行与 Trace 身份及观测插件。
- [`design/agent/pipeline.md`](design/agent/pipeline.md)：主会话 Pipeline 与 Hook。
- [`design/agent/ask-card.md`](design/agent/ask-card.md)：人工确认、中断与恢复。
- [`design/agent/scheduled-task.md`](design/agent/scheduled-task.md)：定时任务、执行和投递。
- [`design/agent/sub-agent.md`](design/agent/sub-agent.md)：子 Agent 委派。
- [`design/session/session-recovery.md`](design/session/session-recovery.md)：会话缓冲、锁与恢复。
- [`design/session/session-trajectory.md`](design/session/session-trajectory.md)：会话轨迹只读审计视图的信息架构、视觉定稿与数据需求。
- [`design/tool/tool-system.md`](design/tool/tool-system.md)：系统工具注册与分发。
- [`design/infra/bootstrap.md`](design/infra/bootstrap.md)：服务启动、自检和初始化。
- [`guides/production-readiness.md`](guides/production-readiness.md)：生产发布与运行检查。

### 模块开发标准

- [`../backend/src/README.md`](../backend/src/README.md)：从 HTTP Controller 到 DTO、用例、Port 与 Adapter 的人工审查导航。
- [`standards/typescript-common-conventions.md`](standards/typescript-common-conventions.md)：跨仓共享的 TypeScript 通用规范，与 Runtime SDK 仓逐字相同，由 `scripts/check-shared-files.mjs` 校验。
- [`standards/typescript-coding-conventions.md`](standards/typescript-coding-conventions.md)：产品仓特有的 TypeScript 约束（前端、契约来源、HTTP 边界、组装与门禁）。
- [`../backend/docs/standards/development-workflow.md`](../backend/docs/standards/development-workflow.md)：后端开发流程。
- [`../frontend/docs/standards/coding-conventions.md`](../frontend/docs/standards/coding-conventions.md)：前端编码规范。
- [`../frontend/docs/standards/development-workflow.md`](../frontend/docs/standards/development-workflow.md)：前端开发流程。

### Design System 规范

- [`../design-system/docs/frontend-ui-coverage.md`](../design-system/docs/frontend-ui-coverage.md)：正式前端覆盖关系。
- [`../design-system/docs/iconography.md`](../design-system/docs/iconography.md)：图标规范。
- [`../design-system/docs/interaction-accessibility.md`](../design-system/docs/interaction-accessibility.md)：交互与无障碍。
- [`../design-system/docs/layout-responsive.md`](../design-system/docs/layout-responsive.md)：布局与响应式。
- [`../design-system/docs/system-states.md`](../design-system/docs/system-states.md)：系统状态。
- [`../design-system/src/foundations/`](../design-system/src/foundations/)：可运行的 Foundation 页面。
- [`../design-system/src/showcase/`](../design-system/src/showcase/)：真实组件 Showcase。
- [`../design-system/src/styles/design-tokens.css`](../design-system/src/styles/design-tokens.css)：token 单一实现源。

项目入口与模块说明仍位于根及模块 README；AI 开发规则位于根和模块 `AGENTS.md`。新增、删除、
移动或重命名上述活文档时，必须同步本索引；`make docs-check` 会检查是否漏收录。

## 决策记录

- [`decisions/`](decisions/)：决策记录（格式为 ADR 式的「背景 / 选项 / 决策 / 理由 / 后果」），
  只追加不修改。**不是全部都是架构决策**，因此不用「ADR」泛指它们。

决策记录用于解释“当时为什么这样决定”，不作为当前接口或行为的唯一依据。当前行为以活文档、
可执行契约、Design System 页面和源码为准。
