# 前端开发流程

> 本文件只写前端特有的流程约束。
> **通用流程（三样产出、触发判据、红线、六阶段、文档影响审查、交付核验）见跨仓共享件
> [`../../../docs/standards/development-workflow.md`](../../../docs/standards/development-workflow.md)**，
> 本节不重复。

## 各阶段的前端特有内容

### 1 需求

验收条件写清做什么、边界在哪、不做什么。跨模块需求落仓库根 `docs/plans/<date>-<feature>.md`，
仅影响前端时落 `frontend/docs/plans/<date>-<feature>.md`。视觉验收条件按「Showcase 状态」定义。

### 2 计划

**UI 组件盘点（必做）**：

- 列出本次需要的 UI 组件；
- 已存在于 [design-system](../../../design-system/AGENTS.md) 的 → 直接引用；
- 缺少共享组件或需要改变 token / 基础视觉语言 → **先到 design-system 评审，用户确认后再进编码**；
- 页面级业务容器 → 留在 frontend，复用现有组件与 token。

与其他阶段共用的计划内容：技术方案（涉及哪些页面/组件、数据流怎么走）、接口与状态变更、任务拆解。

**进入编码的硬性条件：UI 组件缺口已填、计划写清楚。**

### 3 编码

**测试分层（前端特有）**：

| 层面 | 方法 | 测试策略 |
|------|------|---------|
| 逻辑层（hooks、store、service、utils） | 输入 → 输出断言 | **严格 TDD**，Red → Green → Refactor |
| 组件层（交互行为） | Testing Library 渲染 + 模拟操作 | 先定义验收状态；可自动化行为先写失败测试再实现，结构/样式骨架可先搭建 |
| 视觉层（样式、动画） | Showcase + Dev server 目视确认 | 先定义视觉验收条件，覆盖 Light/Dark 与必要视口，不强写像素单测 |

**组件规范与状态管理**：见 [`coding-conventions.md`](coding-conventions.md) §2（组件结构）、
§3（样式与 token）、§4（状态管理）。

**设计系统同步**：见 [`../../../design-system/AGENTS.md`](../../../design-system/AGENTS.md)「同步机制」
（alias 映射、漂移检查、token 同步）；前端侧只需验证 `pnpm typecheck && pnpm build` 仍通过。

### 4 验证

**硬性门禁（全部必须通过）**：逐项清单见
[`../../../docs/standards/typescript-coding-conventions.md`](../../../docs/standards/typescript-coding-conventions.md)「门禁」。
前端侧即 `pnpm format:check` + `pnpm typecheck` + `pnpm lint` + `pnpm test` + `pnpm build`。

**目视确认**（`pnpm dev` → http://localhost:5173），检查清单：

- [ ] 页面/组件渲染正常
- [ ] 交互行为正确（点击、输入、hover）
- [ ] 暗色模式下颜色不突兀
- [ ] 无布局溢出或错位
- [ ] loading / 空状态 / error 三种状态都出现过
- [ ] 注释为简体中文且与实现同 diff 更新（无英文残留注释、无失真注释）

### 5 文档更新

**文档影响审查不可跳过**：查看本次完整 diff，先打开仓库 `docs/README.md`，再沿活文档索引逐项判断
相关 `AGENTS.md`、`README.md`、Design System 的 Foundation / Showcase / 可下载规范以及接口契约。
无需修改时也要在交付说明中记录理由。

**判定表**：

| 变更类型 | 需要更新什么 |
|---------|-------------|
| Bug fix / 小调整 | 通常不需要 |
| 给已有模块加功能 | 更新 `docs/design/<module>/` |
| 新增页面/模块 | **必须新建** `docs/design/<module>/`，更新 AGENTS.md |
| 修改 design-system 组件 | 验证前端 build/typecheck（alias 自动引用） |
| 工具链命令变化 | 更新 `frontend/AGENTS.md` |
| 文档增删、移动、改名或分类变化 | 更新 `docs/README.md`，并检查所有相关活文档的链接与语义 |

### 6 交付

- [ ] format:check + typecheck + lint + test + build 全部通过
- [ ] 目视确认无问题
- [ ] 文档影响已审查；必要文档已更新，无需更新项已有理由
- [ ] 涉及 design-system 变更的已同步到 frontend
- [ ] commit message 描述清晰
- [ ] 仅在用户明确授权时 commit、push 或 merge

## 模块级 vs 非模块级

| 属于模块级 | 不属于模块级 |
|-----------|-------------|
| 新增页面/路由 | 修 bug |
| 新增或修改 design-system 组件 | 调整文案/样式微调 |
| 新增 Zustand store | 重构内部实现 |
| 新增对外 API 调用 | 补充测试 |

模块级变更 → 必须走完六阶段（阶段 5 必须做）。非模块级变更 → 阶段 5 可以不修改文档，但仍须完成
文档影响审查。
