# AGENTS.md · Backend

Backend AI 开发助手手册。写代码前先读仓库根 `AGENTS.md` 和本文件，再按需查阅关联文档。

## 项目定位

业务后端是严格 TypeScript 实现，Node.js 运行编译后的 ESM JavaScript。HTTP/SSE、PostgreSQL schema
与迁移历史、Redis key/TTL、MinIO、认证和 Agent 行为均由 TypeScript 实现与测试维护。

## API 契约同步（硬性红线）

改接口、错误码或路由前，先读 `../api-contract/src/`；`@red-bean/api-contract` 是前后端共享线协议的
机器唯一事实来源。再读 [`../docs/contracts/api.md`](../docs/contracts/api.md) 了解语义说明和示例。

- 改完接口必须同步共享 DTO、路由、错误码、运行时守卫，以及文档的路由总表、逐路由说明和错误码表。
- TypeScript 的路由/SSE 双向契约测试属于 `make be-test`；文档只能作为共享契约的同步投影。
- 错误输出统一为 `{code, message, data:null}`。未知错误不得向客户端泄露内部细节，完整信息进入日志和 span。

## 当前目录与边界

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

TypeScript 保持以下依赖方向：

- `src/modules/*/controller` 是与 Fastify 解耦的 HTTP 用例控制器：方法签名即"入参 + 返回"（入参 DTO/标量与
  AbortSignal），可以完成 wire DTO 投影与 HTTP 应用错误映射，但不导入 Fastify 类型、不建立数据库、Redis
  或 MinIO 连接；`*.routes.ts` 承载请求解包、Principal/Bearer
  提取、成功信封与 SSE/下载流等传输投影。
- `src/modules` 持有产品领域与编排。需要外部系统的实现通过 Port 和构造参数接入，不读取全局容器。
- `src/platform` 持有跨业务模块的 LLM / Tool 能力注册，不包含 HTTP 或产品用例。
- `src/infra` 实现外部系统适配，不包含产品决策。
- 各 `*.module.ts` 负责 Module 内 `Port → 默认实现`，`src/app/composition-root.ts` 只连接基础设施和 Module
  公开能力，是跨 Module 完整依赖图的事实来源；两者都不得退化为运行期 Service Locator。`*.module.ts` 按
  "组装目录"组织：组装体按能力拆成私有工厂函数（函数名即段落标题），主入口只保留工厂调用与返回组装，
  每段配段标题注释，保证组装清单一条流水线读完。
- `src/entrypoint/server.main.ts` 和 `src/entrypoint/migrate.main.ts` 只负责信号、配置、元数据、退出码和启动调用。

产品展示和 Session 属于宿主，不得移回 Runtime。产品 Session、恢复缓冲、持久化模型和跨 Module Port
使用业务自有类型；SDK Message/Event/Checkpoint 只在 Agent Runtime Adapter 边界映射。Fastify、`pg`、
Redis、MinIO 和 OpenTelemetry 的具体类型同样不能扩散到无关业务模块。

生产源码直接导入 `red-bean-qing-tuan` 的白名单仅为 `modules/agent/execution/adapter/`、
`platform/{llm,tool,observability}/` 和 `app/composition-root.ts`。其他位置必须依赖业务 Port/Model；此约束由
`pnpm architecture:check` 扫描全部 `backend/src`。

## Provider 与运行期边界

- LLM Registry 位于 `src/platform/llm`，Tool Registry 位于 `src/platform/tool`；都在启动期注册后封闭。
- Agent Loader 只接收 Runtime 的中性 `LLMAdapterFactory` 与只读 Tool Catalog。
- 新增工具默认只注册，不自动加入 Agent 的 `sys_tool_ids`；默认授权是独立安全决策。
- 模型、端点、凭据和 Agent 授权在下一次运行加载；已经开始的流式运行不切换 Adapter。
- 产品不提供动态代码安装、进程外 Provider 或 Supervisor。部署平台负责实例替换，应用负责探针与优雅退出。

详细架构见
[`../docs/design/backend/architecture.md`](../docs/design/backend/architecture.md)，技术选型见
[`STACK.md`](STACK.md)。
从接口逐层人工审查时，先读 [`src/README.md`](src/README.md) 的调用链矩阵。

HTTP 边界按业务能力组织在 `src/modules/<module>/**/controller/`；公开 DTO 集中在
`../api-contract/src/<module>/dto.ts`。后端同名 `*.dto.ts` 只允许 type re-export，不得增加本地 wire 定义
或函数。输入 Schema 与校验放在 `*-request-parser.ts` 或共享 `validators.ts`，领域到 wire 的纯映射放在
`*-presenter.ts`。Controller 与路由绑定分别放在 `*.controller.ts` 和 `*.routes.ts`：Controller 保持与
Fastify 解耦的用例签名，并负责 wire DTO 投影和 HTTP 应用错误映射；路由文件负责在 handler 首段解包
`request.params/query/body`（调用 parser
与 `authenticatedPrincipal`/`requestAbortSignal`），再用 `shared/http/response.ts` 的 `sendOk` 输出成功
信封；流式端点（SSE、下载流）由路由层做传输投影（`sendSse`/`reply.send(stream)`），Controller 只返回
业务流对象。路由不得重新内联同类 Schema/serializer。领域模型和 Repository Port 不依赖 HTTP DTO，
持久化 row DTO 也不得与 HTTP DTO 混用。

## TypeScript 编码规则

所有 `.ts` 遵循跨仓共享的通用规范
[`../docs/standards/typescript-common-conventions.md`](../docs/standards/typescript-common-conventions.md)，
产品仓特有约束见 [`../docs/standards/typescript-coding-conventions.md`](../docs/standards/typescript-coding-conventions.md)。
**本节不重复通用规则**（类型标注边界、`unknown` 起步、禁用 Decorator/Service Locator、接口角色后缀、
`implements` 义务、接口白名单判据、调用点可读性、判空、命名、cause 链等都在通用件里），
只列后端特有的落点与额外约束：

- 可选字段的缺失与显式 `undefined` 不混用；**数据库 nullable 必须明确映射**。
- Port 的 JSDoc 应注明默认实现与 composition root 组装位置。
- Module 内默认实现在对应 `*.module.ts` 通过 `new ConcreteClass(...)` 绑定；全局
  `src/app/composition-root.ts` 只负责跨 Module 接线和进程级基础设施。生产代码不得用匿名对象充当默认实现；
  factory 返回协议对象时必须声明返回类型或使用 `satisfies`。测试 fake 可使用对象字面量，但必须接受显式
  Port 类型约束。
- 无对应接口的默认实现类登记在 `scripts/architecture-rules.mjs` 的
  `NON_PORT_IMPLEMENTATION_CLASSES` 白名单并附改造记录说明。
- `*RouteDependencies` 等 Controller 依赖清单必须用中文 JSDoc 标明各依赖的生产默认实现，并指向
  对应 `*.module.ts`；涉及跨 Module 绑定时再指向 `src/app/composition-root.ts`。默认绑定变化时，接线代码与
  该注释必须在同一次变更中更新。
- 注释的适用范围、机械门禁与书写要求见共享通用规范「注释」；新增公开模块、DTO、Port、Adapter 或
  复杂编排时必须补充足以支持人工审查的中文职责说明。
- `public-api.ts` 不得通过业务 Model/Port 转发 Runtime SDK 类型；公开边界需要的 JSON 与消息结构由产品
  Module 持有，转换函数放在 Adapter、serializer 或 presenter，不能放进纯数据 model。
- Service、Adapter 和 Model 不得为兼容旧路径转发 Port 或其他权威类型；消费者必须直接从定义文件
  导入。`public-api.ts` 只暴露跨 Module 真正需要的 Model、Port 和组装工厂，不得直接导出内部
  Repository、Adapter、ObjectStorage 或 serializer helper。
- Routes 100 行、Controller 200 行、主 Service 250 行、Adapter 300 行和单个测试 400 行为职责审查触发线，
  不是机械失败线；超限项必须自然拆分或在相邻模块文档记录保留理由。
  - 现状（2026-10-13 记录）：`modules/**/controller/*.routes.ts` 在端点 handler 按「函数与流程可读性」
    具名化后普遍超线（如 `task.routes.ts` 271、`identity.routes.ts` 219、`storage.routes.ts` 188，
    改写前分别为 204/163/149）。**评估结论：保留，暂不拆分。** 理由是这些文件的固有规模来自端点数量，
    handler 抽到同文件模块级后，注册处退化成一张端点清单、链路指纹注释与 handler 同处一文件，
    拆到 `*-route-handlers.ts` 反而让「注册 → 链路 → 实现」多一次跨文件跳转。若端点继续增长，
    按业务面拆分为独立 route 文件而不是把 handler 抽走。

人工追踪构造注入时固定使用：`依赖字段 → Port 定义 → implements 搜索 → 对应 *.module.ts 中的 new →
实现方法`；只有跨 Module 连接才继续查看 `composition-root.ts`。调用处没有 `new` 是构造注入的结果，
不代表实现关系可以隐式存在。

## 开发与测试流程

按“需求 → 计划 → 编码 → 验证 → 文档影响审查 → 交付”执行，详见
[`docs/standards/development-workflow.md`](docs/standards/development-workflow.md)。

- 可观察行为使用 Red → Green → Refactor；bug 能自动复现时必须先写失败回归测试。
- TypeScript 测试位于 `backend/test` 的对应分层；生产导入使用 ESM `.js` 后缀。
- 纯逻辑优先用内存 fake；SQL、Redis 原子语义、MinIO 和完整 HTTP 生命周期必须有真实基础设施证据。
- 新功能覆盖核心 happy path 和主要 error path；外部输入至少覆盖非法形状。
- 纯文档、配置、生成文件或机械接线可不先写测试，但要说明原因并运行最近风险的静态或集成检查。

## 决策权限

- 必须询问：破坏公开契约、不可逆数据变更、现有范围外的新能力、外部成本或未批准的安全边界变化。
- Fastify、PostgreSQL、Redis、MinIO、Croner、OpenTelemetry 等已批准的等价迁移依赖可直接安装和接线，
  不重复询问。
- 已批准 plan 内的兼容扩展、migration、启动组装与跨模块重构，告知影响后继续。
- 实现、测试、文档同步和本地验证可自主完成；commit、push、部署仍须用户明确授权。

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

## 文档影响

每次完成代码、依赖、命令或目录变化后，从
[`../docs/README.md`](../docs/README.md) 打开相关活文档并逐份判断。架构与目录更新本文件和架构设计；
启动、配置和命令更新 README/guide；HTTP/SSE 更新 contract；迁移、lease、观测和调度更新对应 design。
`make docs-check` 只验证机械事实，不能代替语义审查。
