# 前端开发流程规范

> 每个变更都按以下 6 个阶段推进，但产物深度遵循仓库根 `AGENTS.md` 的变更分级；轻量变更不需要
> 为了满足形式而新建 spec/plan。

---

## 流程总览

| 阶段 | 产出 | 完成标准 |
|------|------|---------|
| 1. 需求 | 验收条件；架构/兼容性变更写 spec | 说清做什么、边界在哪、不做什么 |
| 2. 计划 | 实施步骤；架构/兼容性变更写 plan | 技术方案 + 任务拆解 + UI 组件盘点 |
| 3. 编码 | 代码 + 测试 | 逻辑层 TDD，组件层行为测试 |
| 4. 验证 | 全绿 + 目视 | typecheck + lint + test + build + 目视确认 |
| 5. 文档审查与更新 | 影响结论 + 必要文档 | 每次必审；按变更类型决定是否修改 |
| 6. 交付 | 交付说明；按授权提交/同步 | 回顾计划与实际一致，同步 design-system |

---

## 文档生命周期

spec 和 plan 在当前任务的确认、实施阶段可以修订；任务交付后应标明状态并冻结，保留当时的需求、
方案与实际偏差。后续实现变化更新 `docs/design/`、`docs/contracts/`、Design System 当前规范、
当前标准或 README，不回写历史 spec / plan 来描述新现状。完整分类见仓库
[`docs/README.md`](../../../docs/README.md)。

---

## 各阶段详解

### 1. 需求讨论

**目的**：对齐要做什么、为什么做、边界在哪。

**产出**：轻量或标准变更可记录在当前任务上下文；架构/兼容性变更必须落盘。仅影响前端时使用
`frontend/docs/specs/<feature>.md`，跨模块需求使用仓库根 `docs/specs/<feature>.md`。

**内容要求**：
- 功能描述（一句话说清）
- 用户场景（谁、在什么情况下、想做什么）
- 功能边界（做什么、不做什么）
- 验收标准（怎么算做完了）

**完成标准**：spec 写清楚后确认，再进入计划阶段。

---

### 2. 实现计划

**目的**：确定技术方案，拆解可执行的任务。

**产出**：轻量或标准变更可使用当前任务中的简短实施步骤；架构/兼容性变更必须落盘。仅影响前端时
使用 `frontend/docs/plans/<date>-<feature>.md`，跨模块计划使用仓库根
`docs/plans/<date>-<feature>.md`。

**内容要求**：
- 技术方案（涉及哪些页面/组件、数据流怎么走）
- **UI 组件盘点**（必做）：
  - 列出本次需要的 UI 组件
  - 已存在于 [design-system](../../../design-system/AGENTS.md) 的 → 直接引用
  - 缺少共享组件或需要改变 token/基础视觉语言 → **先到 design-system 评审，用户确认后再进编码**
  - 页面级业务容器 → 留在 frontend，复用现有组件与 token
- 接口/数据变更（是否新增 API 调用、状态结构变化）
- 任务拆解（按执行顺序列出独立子任务）

**完成标准**：计划覆盖所有 spec 需求点，组件缺的先补齐。

**进入编码的硬性条件**：UI 组件缺口已填、计划写清楚之前不写代码；不要求每次都新建计划文件。

---

### 3. 编码实现

**目的**：按计划实现功能。

**测试分层（前端特有）**：

| 层面 | 方法 | 测试策略 |
|------|------|---------|
| 逻辑层（hooks、store、service、utils） | 输入 → 输出断言 | **严格 TDD**，Red → Green → Refactor |
| 组件层（交互行为） | Testing Library 渲染 + 模拟操作 | 先定义验收状态；可自动化行为先写失败测试再实现，结构/样式骨架可先搭建 |
| 视觉层（样式、动画） | Showcase + Dev server 目视确认 | 先定义视觉验收条件，覆盖 Light/Dark 与必要视口，不强写像素单测 |

Bug 修复能自动复现时，必须先添加失败的回归测试并确认失败原因正确。纯文档、配置、生成文件或无法可靠自动化的视觉变化可以不先写测试，但必须说明原因并执行最接近风险的验证。

**组件规范与状态管理**：见 [`coding-conventions.md`](coding-conventions.md) §2（组件结构）、
§3（样式与 token）、§4（状态管理），本节不重复。

---

### 4. 自检验证

**目的**：确保代码质量和功能正确。

**硬性门禁（全部必须通过）**：逐项清单见
[`../../../docs/standards/typescript-coding-conventions.md`](../../../docs/standards/typescript-coding-conventions.md)「门禁」。
前端侧即 `pnpm format:check` + `pnpm typecheck` + `pnpm lint` + `pnpm test` + `pnpm build`。

**目视确认**（打开 dev server 人工检查）：

```bash
pnpm dev   # → http://localhost:5173
```

检查清单：
- [ ] 页面/组件渲染正常
- [ ] 交互行为正确（点击、输入、hover）
- [ ] 暗色模式下颜色不突兀
- [ ] 无布局溢出或错位
- [ ] loading / 空状态 / error 三种状态都出现过
- [ ] 注释为简体中文且与实现同 diff 更新（无英文残留注释、无失真注释）

---

### 5. 文档更新

**目的**：保持文档与代码同步。

**文档影响审查不可跳过**：查看本次完整 diff，先打开仓库 `docs/README.md`，再沿活文档索引逐项判断相关 `AGENTS.md`、`README.md`、Design System 的 Foundation / Showcase / 可下载规范以及接口契约是否仍准确。无需修改时也要在交付说明中记录理由，禁止用无意义改字伪装同步。

**判定表**：

| 变更类型 | 需要更新什么 |
|---------|-------------|
| Bug fix / 小调整 | 通常不需要 |
| 给已有模块加功能 | 更新 `docs/design/<module>/` |
| 新增页面/模块 | **必须新建** `docs/design/<module>/`，更新 AGENTS.md |
| 修改 design-system 组件 | 验证前端 build/typecheck（alias 自动引用，见下方同步协议） |
| 工具链命令变化 | 更新 `frontend/AGENTS.md` |
| 文档增删、移动、改名或分类变化 | 更新 `docs/README.md`，并检查所有相关活文档的链接与语义 |

**设计系统同步协议**：见 [`../../../design-system/AGENTS.md`](../../../design-system/AGENTS.md)「同步机制」
（alias 映射、漂移检查、token 同步），本节不重复。前端侧只需验证 `pnpm typecheck && pnpm build` 仍通过。

---

### 6. 交付

**目的**：收尾，确保交付产物完整。

**清单**：
- [ ] format:check + typecheck + lint + test + build 全部通过
- [ ] 目视确认无问题
- [ ] 文档影响已审查；必要文档已更新，无需更新项已有理由
- [ ] 涉及 design-system 变更的已同步到 frontend
- [ ] commit message 描述清晰
- [ ] 仅在用户明确授权时 commit、push 或 merge

---

## 模块级 vs 非模块级

| 属于模块级 | 不属于模块级 |
|-----------|-------------|
| 新增页面/路由 | 修 bug |
| 新增或修改 design-system 组件 | 调整文案/样式微调 |
| 新增 Zustand store | 重构内部实现 |
| 新增对外 API 调用 | 补充测试 |

模块级变更 → 必须走完 6 阶段（阶段 5 必须做）。
非模块级变更 → 阶段 5 可以不修改文档，但仍须完成文档影响审查，其余照走。
