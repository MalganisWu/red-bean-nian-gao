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
  [`AGENTS.md`](../../AGENTS.md)「门禁」。
- **改 Runtime SDK 的公开行为或接入方式**时，本仓按 `runtime.lock` 消费它：先改 SDK 仓并提交，
  本仓 bump lock 时逐字比对会强制同步。

## UI 变更：mock 先行（本仓特有）

改动涉及界面（新增页面、组件、交互或视觉）时，在通用六阶段的**阶段 1 需求**与**阶段 2 计划**
之间多两步。任务步骤与组件状态在每一步上对齐——**本节是组件状态定义的唯一事实来源**：

| 步 | 做什么 | 组件状态 |
| --- | --- | --- |
| ① | 产出 mock：落 `design-system/previews/`，本地、**不入库**；可同时有多个候选 | `proposal` |
| ② | **开发者目视确认方向**；不通过回 ① | → `accepted` |
| ③ | 进阶段 2：plan 只写已确认的方向，不写待定候选 | `accepted` |
| ④ | 阶段 3 先落 design-system：真实组件 + Showcase | → `implemented` |
| ⑤ | 前后端开发：前端引用已入册组件，后端供接口 | `implemented` |
| ⑥ | 验收 | `implemented` |
| — | 组件退场：先标出替代方案与移除窗口，再清空引用 | `deprecated` → `removed` |

状态准入条件：

- `proposal` 无门槛——草稿即可，多个候选并存，不对前端承诺
- `accepted` = 人工确认 + token 与交互口径冻结
- `implemented` = 真实组件、Showcase、正式消费方**三者一致**
- `deprecated` = 已标出替代方案与移除窗口，不再新增消费方
- `removed` = 无正式引用 + 无文档残留 + 通过漂移检查，**三条同时成立**

**只有两次跃迁需要人介入**：`proposal → accepted`（确认方向）与 `implemented` 前的目视验证。

- **mock 是草稿，不是产出物**：文件只落在本地 `design-system/previews/`（已被 `.gitignore` 忽略）；
  确认结论写进 plan 或提交说明，草稿本身不留档。
- **顺序不可颠倒**：plan 必须写已确认的视觉方向；design-system 先于前后端开发，前端只能引用
  已入册的组件。
- **非 UI 改动不走这条**（纯后端、纯文档、纯配置），直接走通用六阶段。

## Design System 资产变更分级（本仓特有）

| 变更类型 | 处理方式 |
| --- | --- |
| 新增缺失文档、状态清单、语义说明 | 可直接补充，并在提交中注明来源 |
| 修正文案与现有实现不一致 | 按当前已确认实现修正，不改变视觉 |
| 调整颜色、圆角、字体、间距、层级或交互 | 先创建独立 Preview，经人工确认后同步 |
| 新建或修改共享组件 | 组件与 Showcase 同步更新，再验证正式前端 |
| 删除组件或公开 variant | 先核对正式消费方，记录迁移方案后执行 |

**评审记录**：影响现有视觉的提案必须在提交或计划文档中记录问题证据、确认结果、受影响组件、
迁移范围和验证结果。Preview 文件本身不入库，留档的是**确认记录**而非草稿；没有确认记录的
Preview 不得被视为正式规范。

资产的唯一定位（token / 组件 / Showcase / 业务容器各归哪）见
[`../../design-system/AGENTS.md`](../../design-system/AGENTS.md)。

## 测试先行分层（本仓特有）

| 改动类型 | 测试要求 |
| --- | --- |
| Bug 修复 | 能自动复现时，先添加失败的回归测试并确认失败原因正确 |
| TypeScript 后端、前端 hooks / store / service / utils | 严格执行 Red → Green → Refactor |
| React 组件交互 | 先列出状态与交互验收场景；可自动化的行为先写失败测试再实现。允许先搭结构或样式骨架，测试在功能完成前补齐 |
| 纯视觉样式、动画、Design System 探索 | 先定义 Showcase 状态与视觉验收条件，通过 Light/Dark、必要视口与人工目视验证；不强行为颜色或像素写脆弱单测 |
| 纯文档、配置、生成文件、机械接线 | 可以不先写测试，但必须说明原因并执行最接近风险的静态、构建、契约或手工验证 |

TDD 约束的是**行为增量**，不要求为每一行实现代码单独写测试。重构应在已有测试保持绿色的前提下进行。
