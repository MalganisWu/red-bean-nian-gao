# AGENTS.md · Backend

Backend 治理入口：目录边界、路由与命令。**编码规范与开发流程的规则本体在 Skill 里**，本文件不重复。

## 开始任务

1. 完整读取仓库根 [`AGENTS.md`](../AGENTS.md)。
2. 完整读取本文件。
3. 完整读取下面「编码规范」与「开发与测试流程」指向的 Skill——**规则本体在那里**。
   规则冲突时以离目标文件最近者为准。

## 编码规范

所有 `.ts` 遵循跨仓共享的通用规范
[`../docs/standards/typescript-common-conventions.md`](../docs/standards/typescript-common-conventions.md)，
后端与 api-contract 的特有约束见
[`../skills/red-bean-nian-gao-backend-coding-conventions/SKILL.md`](../skills/red-bean-nian-gao-backend-coding-conventions/SKILL.md)
——语言与风格、架构与依赖方向、HTTP 边界与 Controller、组装与实现绑定、Provider 与运行期边界、
契约与公开边界、行数触发线、注释。

后端 `sys_*` 系统工具的专项工作流见仓库级 Skill
[`../skills/make-agent-system-tools/SKILL.md`](../skills/make-agent-system-tools/SKILL.md)。

## 开发与测试流程

按「需求 → 计划 → 编码 → 验证 → 文档 → 交付」执行。通用流程（三样产出、三条红线、六阶段、
执行纪律、文档影响审查、交付核验）见
[`../skills/red-bean-nian-gao-development-workflow/SKILL.md`](../skills/red-bean-nian-gao-development-workflow/SKILL.md)；
**后端特有的流程约束与测试分层**见
[`docs/standards/development-workflow.md`](docs/standards/development-workflow.md)。

## 目录与边界

### 代码

```text
backend/
├── src/
│   ├── entrypoint/       server / migrate 的薄进程入口
│   ├── app/              全局 composition root、HTTP server 与生命周期
│   ├── modules/          Agent、Task、Identity、Storage、System 业务模块
│   ├── platform/         LLM / Tool Provider 与启动期 Registry
│   ├── shared/           跨模块 HTTP 等薄共享机制
│   └── infra/            配置、PostgreSQL（含迁移目录 `database/migrator.ts`）、Redis、日志、观测与 ID
├── test/                 TypeScript 单元、契约、集成测试
└── package.json          TypeScript package 与生产依赖
```

### 依赖方向

- `src/modules` 持有产品领域与编排；需要外部系统的实现通过 Port 和构造参数接入，不读取全局容器。
- `src/platform` 持有跨业务模块的 LLM / Tool 能力注册，不包含 HTTP 或产品用例。
- `src/infra` 实现外部系统适配，不包含产品决策。
- 各 `*.module.ts` 负责 Module 内 `Port → 默认实现`；`src/app/composition-root.ts` 只连接基础设施和
  Module 公开能力，是跨 Module 完整依赖图的事实来源。两者都不得退化为运行期 Service Locator。
- `src/entrypoint/server.main.ts` 和 `src/entrypoint/migrate.main.ts` 只负责信号、配置、元数据、退出码
  和启动调用。

「某个目录里怎么写代码」在编码规范 Skill 的「架构与依赖方向」「HTTP 边界与 Controller」「组装与
实现绑定」三节；本节只定「谁在哪里」。

### 公开边界

生产源码直接导入 `red-bean-qing-tuan` 的白名单**仅为** `modules/agent/execution/adapter/`、
`platform/{llm,tool,observability}/` 和 `app/composition-root.ts`；其他位置必须依赖业务 Port/Model。
该约束由 `pnpm architecture:check` 扫描全部 `backend/src`。

详细架构见 [`../docs/design/backend/architecture.md`](../docs/design/backend/architecture.md)，
技术选型见 [`STACK.md`](STACK.md)。从接口逐层人工审查时，先读
[`src/README.md`](src/README.md) 的调用链矩阵。

## 接口变更的同步义务

改接口、错误码或路由前，先读 [`../api-contract/src/`](../api-contract/src/)——它是一段可直接 import 的
TypeScript 代码，前端与后端共用同一个包 `@red-bean/api-contract`（见根
[`AGENTS.md`](../AGENTS.md)「前后端共用契约包（硬性红线）」）。再读
[`../docs/contracts/api.md`](../docs/contracts/api.md) 了解语义说明和示例。

- 改完接口必须同步共享 DTO、路由、错误码、运行时守卫，以及文档的**路由总表、逐路由说明和错误码表**。
- 后端路由与 SSE 的双向契约测试属于 `make be-test`；文档只能作为共享契约的同步投影。
- 错误输出统一为 `{code, message, data:null}`。未知错误不得向客户端泄露内部细节，完整信息进入日志和 span。

## 决策权限

权限分档（必须询问 / 告知后继续 / 自主执行）与提交、分支规范见根 [`AGENTS.md`](../AGENTS.md)「决策权限」。
后端特有的只有一条：

- **已批准的等价迁移依赖**——Fastify、PostgreSQL、Redis、MinIO、Croner、OpenTelemetry——可直接安装
  和接线，不重复询问。

## 常用命令

```bash
make run                    # 默认 TypeScript server，http://localhost:8080
make db-migrate             # TypeScript migrator up
make db-status              # TypeScript migrator status
make db-rollback            # TypeScript migrator down
make backend-ts-verify      # TS 格式、类型、Lint、测试和构建
make be-test                # TS 单元、契约及可选集成测试
make be-test-integration    # 强制真实 PostgreSQL/Redis/MinIO 集成测试
make verify                 # 全仓 TypeScript 门禁
make verify-full            # 发布级门禁和真实基础设施测试
```

**这两类不是一回事，报告里不得混写**：`make verify` 不依赖外部服务；`make be-test-integration` 与
`make verify-full` 需要真实的 PostgreSQL / Redis / MinIO。本地与 CI 没有可用服务时，可以先交付
代码，但交付说明要逐项标注真实服务验证「待验证」——**不得把 `make verify` 通过写成真实基础设施
已验证**。判据见 [`docs/standards/development-workflow.md`](docs/standards/development-workflow.md)「4 验证」。

## 文档影响

每次完成代码、依赖、命令或目录变化后，从
[`../docs/README.md`](../docs/README.md) 打开相关活文档并逐份判断；**通用义务与判定表见根
[`AGENTS.md`](../AGENTS.md)「文档影响审查」**。后端特有的落点：架构与目录更新本文件和
[`../docs/design/backend/architecture.md`](../docs/design/backend/architecture.md)；启动、配置和命令更新
README / guide；HTTP/SSE 更新 contract；迁移、lease、观测和调度更新对应 design。
`make docs-check` 只验证机械事实，不能代替语义审查。

## 项目定位

业务后端是严格 TypeScript 实现，Node.js 运行编译后的 ESM JavaScript。HTTP/SSE、PostgreSQL schema
与迁移历史、Redis key/TTL、MinIO、认证和 Agent 行为均由 TypeScript 实现与测试维护。
