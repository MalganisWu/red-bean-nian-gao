# 后端开发流程

> 本文件只写后端特有的流程约束。
> **通用流程（三样产出、触发判据、红线、六阶段、文档影响审查、交付核验）见跨仓共享件
> [`../../../docs/standards/development-workflow.md`](../../../docs/standards/development-workflow.md)**，
> 本节不重复。

## 各阶段的后端特有内容

### 1 需求

验收条件写清做什么、边界在哪、不做什么。跨模块需求落仓库根 `docs/plans/<date>-<feature>.md`，
仅影响后端时落 `backend/docs/plans/<date>-<feature>.md`。

### 2 计划

计划内容：技术方案（涉及哪些模块、数据流怎么走）、接口变更、数据库变更（是否需要 migration）、
任务拆解（按执行顺序列出独立子任务）、风险点。**计划写清楚之前不写代码**；不要求每次都落盘。
进入编码的硬性条件：跨模块的组件/接口缺口已填。

### 3 编码

- 产品能力写入 `backend/src`。
- TypeScript 测试位于 `backend/test` 的对应分层；生产导入使用 ESM `.js` 后缀。
- 禁止恢复已退役的 `src/api|engine|cli` 与 `test/api|engine|cli`；业务公开 Model/Port 不得转发
  Runtime SDK DTO，产品与 SDK 的消息、事件和 Checkpoint 转换收口在 Runtime Adapter。
- **数据库迁移**：一次任务相关的表、字段、索引和回滚 SQL 作为一个 migration 追加到
  `src/infra/database/migrator.ts`，不修改已执行历史；migration 名称继续使用 14 位时间戳，
  TypeScript migrator 必须兼容既有 history；通过 `make db-migrate` 执行，并用真实 PostgreSQL
  验证 up、status、down 与存量 history。

### 4 验证

一条 `make verify`；逐项清单见根
[`AGENTS.md`](../../../AGENTS.md)「门禁」。

**测试要求**：覆盖核心 happy path 与主要 error path，外部输入至少覆盖非法形状；纯领域测试优先用
内存 fake，SQL / Redis 原子语义 / MinIO / 完整 HTTP 生命周期必须有真实基础设施证据；多 case 场景
用表驱动。

### 5 文档更新

**文档影响审查不可跳过**：查看本次完整 diff，先打开仓库 `docs/README.md`，再沿活文档索引逐项判断。
无需修改时也要在交付说明中记录理由，禁止用无意义改字伪装同步。

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

### 6 交付

- [ ] 所有测试通过、lint 无错误
- [ ] 文档影响已审查；必要文档已更新，无需更新项已有理由
- [ ] commit message 描述清晰
- [ ] 回顾计划：实际实现与计划是否一致？有偏差的更新 design doc
- [ ] 仅在用户明确授权时 commit、push、merge 或提 PR

## 模块级 vs 非模块级

| 属于模块级 | 不属于模块级 |
|-----------|-------------|
| 新增 engine 模块 | 修 bug |
| 修改跨模块公开接口 | 调整日志格式 |
| 新增 migration | 重构内部实现（不改接口） |
| 新增 API 端点 | 补充测试 |
| 新增外部依赖 | 性能优化（不改接口） |

模块级变更 → 必须走完六阶段。非模块级变更 → 阶段 5 可以不修改文档，但仍须完成文档影响审查。
