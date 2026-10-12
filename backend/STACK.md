# 后端技术选型

> 文档性质：活文档。记录当前 TypeScript 生产后端的技术选型与边界。
>
> 最近复核：2026-09-05

## 选型总览

| 层级 | 选型 | 主要边界 |
| --- | --- | --- |
| 语言 / 运行时 | 严格 TypeScript + Node.js 24 | 编译为 ESM JavaScript；不接受裸 JS 业务实现 |
| HTTP | Fastify 5 | 路由、中间件、SSE 与优雅关闭 |
| Schema | Zod 4 + 显式解析器 | HTTP、数据库 JSON、配置等不可信边界运行时校验 |
| PostgreSQL | `pg` 8 + 显式 SQL | 不使用 ORM，不用复杂查询构建器隐藏 SQL |
| 数据库迁移 | TypeScript migrator | 冻结数组式迁移目录 + `schema_migrations` 历史表 |
| Redis | `redis` 6 | 取消、MessageBuffer、lease/fencing 与投递队列 |
| 对象存储 | MinIO JavaScript SDK 8 | 上传、下载、删除与预签名 URL |
| 配置 | `yaml` 2 + 环境变量 + 显式校验 | `config.yaml` → 环境变量（`backend/.env.local` 在入口注入） |
| 认证 | `jose` 6 + `bcryptjs` 3 | JWT 与既有 bcrypt 哈希兼容 |
| 调度 | Croner 10 | Cron 解析；任务 lease、重试和执行仍由产品实现 |
| 观测 | 中性 Tracer + OpenTelemetry | 默认结构化日志，可选 OTLP/HTTP |
| Agent Runtime | `red-bean-qing-tuan` TypeScript package | OpenAI-compatible adapter、Pipeline、Tool 与 Checkpoint 契约 |
| 测试 | Node.js 内置 test runner | 单元、契约和真实基础设施集成测试 |

## 关键决策

### Fastify

- 只在 `src/modules/*/**/controller`、`src/shared/http` 与 `src/app/fastify-http-server.ts` 使用框架对象，领域层不依赖 Fastify。
- plugin 和路由都由 `src/app/composition-root.ts` 显式注册，不使用 Decorator DI 或扫描式容器。
- `inject` 用于 HTTP 边缘测试；真实集成测试还会监听随机端口验证完整 SSE 链路。

### HTTP 边缘顺序

- 请求处理顺序由 Fastify 生命周期固定：onRequest（Abort + CORS + trace）→ body 解析
  （1MiB 上限，超限 413）→ preHandler（auth 在前、限流在后，遇错短路）→ zod 校验 →
  Controller → 信封；错误统一由 setErrorHandler 输出，span 在 onResponse 收尾。
- 认证晚于 body 解析是框架生命周期决定，不做 auth-before-body；缓解手段是 bodyLimit +
  preHandler 限流，勿试图把认证提前到解析层。
- 顺序细节与 fail-closed 点以 `src/shared/http/fastify-http-boundary.ts` 文件头为准。

### API 契约与路由目录

- `api-contract/src/routes.ts` 的 `API_ROUTES` 命名表是全仓接口路径唯一事实来源；后端注册走
  `shared/http/bind-route.ts`（method/path 取自命名表），前端通过 `API_ROUTES` + `buildPath` 拼路径，
  业务代码不手写路由路径字面量。
- 路由模板使用 Fastify 原生语法（`:param`、通配 `*`）；`make contract-verify` 的防撞检查保证同一父路径下
  静态段与参数段不同深度共存，防重复注册。

### PostgreSQL 与迁移

- `pg` 连接池和事务边界集中在 `src/infra/database`，仓储使用参数化 SQL。
- PostgreSQL 行、JSONB、nullable 字段在进入领域层前解析；不会用 TypeScript 断言代替运行时校验。
- TypeScript migrator 内置全部迁移的同序 SQL，按编号顺序读写 `schema_migrations`，不会重放已应用的迁移。
- `src/entrypoint/migrate.main.ts` 提供 `up`、`down`、`status`。生产通过独立 job 执行，应用实例只校验 schema。

### 配置

- `src/infra/config/config.ts` 按 `config.yaml`、环境变量的顺序合并；本地配置统一写在 `backend/.env.local`（gitignored），由 `src/infra/config/load-local-env-file.ts` 在进程入口注入，且不覆盖已存在的环境变量。
- 外部值被显式解析为 string、number、boolean 或 duration，并在启动前校验必填项、占位值和生产安全项。
- 配置对象只由 composition root 读取，业务模块通过构造参数获得所需的最小配置。

### Redis 与对象存储

- Redis 用于运行取消、跨实例 session/task lease、fencing token、MessageBuffer 和 delivery queue；
  readiness 会执行真实 `PING`。
- MinIO client 由 composition root 创建，启动时确保 bucket 存在；对象 key 的用户归属和 presign 上限
  留在产品存储边界。
- MinIO 8.0.7 尚未更新两个存在 moderate DoS 公告的传递依赖；`pnpm-workspace.yaml` 暂时将
  `decode-uri-component` 与 `stream-json` 锁定到修复版。升级 MinIO 后应重新审计并移除不再需要的 override。
- 同一版本 minio 的 ESM 产物还以错误大小写导入 `stream-json/jsonl/Parser.js`（实际文件为小写
  `parser.js`），在大小写敏感的文件系统上（Linux CI、生产容器）加载即抛 `ERR_MODULE_NOT_FOUND`，
  macOS 因文件系统不区分大小写而掩盖了该问题。`pnpm-workspace.yaml` 的 `patchedDependencies`
  将导入路径改回正确大小写；该补丁与上述 override 同源，升级 MinIO 时一并复核。
- 两个客户端都由应用 lifecycle 登记并在退出时反序关闭或停止使用。

### 认证、调度与观测

- `jose` 校验 JWT 算法、有效期和刷新窗口；`bcryptjs` 保持现有密码哈希兼容。
- Croner 只负责 Cron 时间计算，Scheduler 的并发、lease、heartbeat、超时、重试和投递仍是显式产品逻辑。
- Runtime 的中性 `Tracer` 是业务依赖边界。默认 adapter 输出结构化日志；OTel adapter 使用官方 SDK 和
  OTLP/HTTP exporter，并复用 W3C Trace Context。

### Runtime SDK 接入

- 产品是 Harness，Runtime 是其执行 SDK；HTTP、Session、展示、调度和基础设施仍属于产品。
- LLM 和 Tool Provider 在进程启动时注册并封闭。模型、端点、凭据和 Agent 授权在每次新运行加载，
  已开始的流式运行不切换 Adapter。
- 本地开发通过 `backend/package.json` 的 sibling `link:../../red-bean-qing-tuan` 使用 Runtime；
  `runtime.lock` 记录产品验证过的精确 commit。发布前必须把该依赖解析为可复现的不可变产物。

## 当前代码边界

```text
red-bean-qing-tuan/src/
├── runtime/               Runtime 高层门面、运行服务与生命周期
├── agent/                 AgentNode 与 Agent 执行能力
├── pipeline/              中性 Context、Node、事件与运行编排
├── protocol/              Checkpoint、消息、事件和中断协议
├── llm/                   LLM Port 与 OpenAI-compatible adapter
├── tool/                  Tool、Dispatcher 与 builtin
├── observability/         中性 Tracer 与装饰器
├── registry/              静态能力注册表
└── testing/               对宿主开放的契约测试工具

red-bean-nian-gao/backend/src/
├── entrypoint/            server / migrate 进程入口
├── app/                   顶层 composition root、HTTP 装配与资源生命周期
├── modules/               agent、task、identity、storage、system 业务模块
├── platform/              LLM、Tool Provider 与可观测性平台适配
├── infra/                 配置、PostgreSQL、Redis、日志和底层客户端
└── shared/                跨模块稳定共享的 HTTP、错误和基础类型
```

`make run`、`make db-*` 与后端门禁均使用 `backend/src`。
