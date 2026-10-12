# 后端开发流程规范

> 每个变更都按以下 6 个阶段推进，但产物深度遵循仓库根 `AGENTS.md` 的变更分级；轻量变更不需要
> 为了满足形式而新建 spec/plan。

---

## 流程总览

| 阶段 | 产出 | 完成标准 |
|------|------|---------|
| 1. 需求讨论 | 验收条件；架构/兼容性变更写 spec | 说清做什么、边界在哪、不做什么 |
| 2. 实现计划 | 实施步骤；架构/兼容性变更写 plan | 技术方案 + 任务拆解 + 风险点 |
| 3. 编码实现 | 代码 + 测试 | TDD，先测试后实现，覆盖 happy path + 主要 error path |
| 4. 自检验证 | 全绿 | TypeScript 后端门禁通过 |
| 5. 文档审查与更新 | 影响结论 + 必要文档 | 每次必审；按变更类型决定是否修改（见下方判定表） |
| 6. 交付 | 交付说明；按授权提交/同步 | 回顾计划与实际一致 |

---

## 文档生命周期

spec 和 plan 在当前任务的确认、实施阶段可以修订；任务交付后应标明状态并冻结，保留当时的需求、
方案与实际偏差。后续实现变化更新 `docs/design/`、`docs/contracts/`、`docs/guides/`、当前标准或
README，不回写历史 spec / plan 来描述新现状。完整分类见仓库 [`docs/README.md`](../../../docs/README.md)。

---

## 各阶段详解

### 1. 需求讨论

**目的**：对齐要做什么、为什么做、边界在哪。

**产出**：轻量或标准变更可记录在当前任务上下文；架构/兼容性变更必须落盘。仅影响后端时使用
`backend/docs/specs/<feature>.md`，跨模块需求使用仓库根 `docs/specs/<feature>.md`。

**内容要求**：
- 功能描述（一句话说清）
- 用户场景（谁、在什么情况下、想做什么）
- 功能边界（做什么、不做什么）
- 非功能需求（性能、安全、兼容性，如有）
- 验收标准（怎么算做完了）

**完成标准**：spec 写清楚后和团队（或你自己）确认，再进入计划阶段。

---

### 2. 实现计划

**目的**：确定技术方案，拆解可执行的任务。

**产出**：轻量或标准变更可使用当前任务中的简短实施步骤；架构/兼容性变更必须落盘。仅影响后端时
使用 `backend/docs/plans/<date>-<feature>.md`，跨模块计划使用仓库根
`docs/plans/<date>-<feature>.md`。

**内容要求**：
- 技术方案（涉及哪些模块、数据流怎么走）
- 接口变更（是否新增/修改 `core/` 接口）
- 数据库变更（是否需要 migration）
- 任务拆解（按执行顺序列出独立子任务）
- 风险点（哪里可能出问题）

**完成标准**：计划覆盖所有 spec 需求点，任务拆解到可独立执行。

**进入编码的硬性条件**：计划写清楚之前不写代码；不要求每次都新建计划文件。

---

### 3. 编码实现

**目的**：按计划实现功能，TDD 先行。

**要求**：
- 新增或修改可观察行为时执行 Red → Green → Refactor：先写失败测试并确认失败原因正确，再写最小实现，最后在测试保持绿色时重构
- Bug 修复在可自动复现时先添加失败的回归测试；无法自动复现时记录原因和替代验证
- 产品能力写入 `backend/src`
- 禁止恢复已退役的 `src/api|engine|cli` 与 `test/api|engine|cli`；业务公开 Model/Port 不得转发 Runtime SDK
  DTO，产品与 SDK 的消息、事件和 Checkpoint 转换收口在 Runtime Adapter
- 依赖经构造函数或显式 factory 注入，composition root 不得演化为 Service Locator
- 外部输入在 API、数据库、Redis、配置、LLM 或 Tool 边界进行运行时校验
- 异步操作传播 `AbortSignal` 和带上下文的错误，不吞掉 Promise
- 遵守全仓 [TypeScript 规范](../../../docs/standards/typescript-coding-conventions.md)

**测试要求**：
- 覆盖核心 happy path
- 覆盖主要 error path
- 纯领域测试优先用内存 fake；基础设施语义使用隔离的真实 PostgreSQL、Redis、MinIO
- 表驱动测试（多 case 场景）
- 纯文档、配置、生成文件或机械接线可以不先写测试，但必须运行最接近风险的静态、构建、契约或集成检查

**数据库迁移**：
- 一次任务相关的表、字段、索引和回滚 SQL 作为一个 migration 追加到
  `src/infra/database/migrator.ts`，不修改已执行历史。
- migration 名称继续使用 14 位时间戳，TypeScript migrator 必须兼容既有 history。
- 迁移通过 `make db-migrate` 执行，并用真实 PostgreSQL 验证 up、status、down 与存量 history。

---

### 4. 自检验证

**目的**：确保代码质量和功能正确。

**必须通过**：

```bash
make doctor         # 固定工具链版本与 package 声明
make backend-ts-verify # TypeScript 后端格式、类型、Lint、测试与构建
make backend-verify # TypeScript 后端全部检查
make compose-check  # 本地 Compose 安全配置静态检查
make secrets-check  # 环境文件忽略策略与高置信度密钥检查
make verify         # 交付前运行全仓门禁（不修改 Git 跟踪文件）
```

**建议**（非强制）：
- 手动跑一次 happy path
- 检查日志输出是否合理

---

### 5. 文档更新

**目的**：保持文档与代码同步，让下次进来的人（包括 AI）知道发生了什么。

**文档影响审查不可跳过**：查看本次完整 diff，先打开仓库 `docs/README.md`，再沿活文档索引逐项判断相关 `AGENTS.md`、`README.md`、设计/架构文档和契约是否仍准确。无需修改时也要在交付说明中记录理由，禁止用无意义改字伪装同步。

**判定表**：

| 变更类型 | 需要更新什么 |
|---------|-------------|
| Bug fix / 小调整 / 重构（不改接口） | 通常不需要 |
| 给已有模块加功能 | 更新 `docs/design/<module>/` |
| 新增 engine 模块 | **必须新建** `docs/design/<module>/`，更新 `AGENTS.md` 目录结构 |
| 修改跨模块接口 | 更新对应 design doc，检查所有实现与调用方 |
| 新增 migration | 更新 `docs/design/` 中数据库相关文档 |
| 新增/修改编码规范 | 更新 `docs/standards/` 对应文档 |
| 工具链命令变化 | 更新 `backend/AGENTS.md` |
| 目录结构变化 | 更新根 `AGENTS.md`、`backend/AGENTS.md` |
| 文档增删、移动、改名或分类变化 | 更新 `docs/README.md`，并检查所有相关活文档的链接与语义 |

---

### 6. 交付

**目的**：收尾，确保交付产物完整。

**清单**：
- [ ] 所有测试通过
- [ ] lint 无错误
- [ ] 文档影响已审查；必要文档已更新，无需更新项已有理由
- [ ] commit message 描述清晰
- [ ] 回顾计划：实际实现与计划是否一致？有偏差的需要更新 design doc
- [ ] 仅在用户明确授权时 commit、push、merge 或提 PR

---

## 模块级 vs 非模块级

| 属于模块级 | 不属于模块级 |
|-----------|-------------|
| 新增 engine 模块 | 修 bug |
| 修改跨模块公开接口 | 调整日志格式 |
| 新增 migration | 重构内部实现（不改接口） |
| 新增 API 端点 | 补充测试 |
| 新增外部依赖 | 性能优化（不改接口） |

模块级变更 → 必须走完 6 阶段。
非模块级变更 → 阶段 5 可以不修改文档，但仍须完成文档影响审查，其余照走。
