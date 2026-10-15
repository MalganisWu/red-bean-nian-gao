# red-bean-nian-gao Backend

> AI Agent 对话服务的严格 TypeScript 后端实现，提供会话管理、定时任务调度、用户认证和文件存储能力。

## ✨ 特性

- 🤖 **AI Agent 对话** — 流式响应、会话持久化、工具调用、子 Agent 委托
- ⏰ **定时任务调度** — 基于 cron 表达式、重试机制、分布式锁
- 👤 **用户管理** — JWT 认证、bcrypt 密码加密、用户仓储
- 📦 **对象存储** — MinIO 集成、预签名 URL、文件上传下载
- 📊 **结构化日志与 Trace** — 默认 JSON/Text logger，可选 OpenTelemetry OTLP/HTTP，支持 W3C Trace Context
- 🧩 **静态能力 Registry** — 启动期封闭 LLM/Tool Provider Registry 与 Tool Catalog
- 🔄 **优雅停机** — 停止接收新请求、等待在途工作并按逆序关闭资源
- 🔒 **中间件体系** — CORS、RequestID、Trace、错误处理、JWT 认证

## 📚 技术栈

详见 [STACK.md](STACK.md)

核心技术：Node.js 24、严格 TypeScript、Fastify、`pg`、PostgreSQL、Redis、MinIO

## 🚀 快速开始

后端依赖与产品仓同级的 `red-bean-qing-tuan` Runtime；首次运行前在仓库根执行 `make bootstrap`，
它会克隆 SDK 并切到 `runtime.lock` 锁定的版本（详见根目录 [README](../README.md)）。

### 前置依赖

| 工具 | 版本 | 用途 |
|------|------|------|
| **Node.js** | >=24.9.0、<26 | 编译并运行 TypeScript 后端 |
| **pnpm** | 11.x | 安装、构建、测试和启动后端 |
| **Docker** | 最新 | 启动基础设施(PostgreSQL/Redis/MinIO) |
| **Make** | - | 统一任务入口 |

### 1. 创建本地配置

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`，为 PostgreSQL、Redis 和 MinIO 填写不同的本地密码。该文件不会进入 Git；
模板只保存变量名和非敏感默认值。多工作区同时启动时，还应修改 `COMPOSE_PROJECT_NAME`
与四个宿主机端口，避免互相占用。

这一个文件同时是**应用**的配置来源，见下方[配置](#3-配置)。

### 2. 启动基础设施

```bash
make infra-up
# 等待服务就绪(healthcheck 自动检测，约 10-20 秒)
docker compose ps  # 确认所有服务 Status 为 healthy
```

Docker Compose 会启动:
- **PostgreSQL** (默认端口 5432) — 主数据库
- **Redis** (默认端口 6379) — 消息缓存 + 分布式锁
- **MinIO** (默认端口 9000/9001) — 对象存储

所有端口只绑定 `127.0.0.1`，不会默认暴露给局域网或 Tailscale。MinIO 控制台默认为
http://localhost:9001，用户名和密码由 `.env.local` 的 `MINIO_ROOT_*` 定义。

### 3. 配置

同一个 `.env.local` 的**应用键**供应用连接使用。`config.yaml` 是可提交基线，敏感配置故意使用 `CHANGE_ME`，不能直接启动服务。
**本地配置只有一个来源**：`backend/.env.local`（已被 Git 忽略）。

```bash
cp .env.local.example .env.local
```

这一个文件同时承担两件事：

- **基础设施键**（`COMPOSE_PROJECT_NAME` / `POSTGRES_*` / `REDIS_*` / `MINIO_*` / 各 `*_PORT`）——
  由 `docker compose --env-file` 读取，用于**创建**容器；
- **应用键**（`DATABASE_URL` / `REDIS_URL` / `JWT_SECRET` / `MINIO_*` / `LLM_*` / `DEV_USER_*`）——
  由进程入口 `src/infra/config/load-local-env-file.ts` 注入 `process.env`，供应用**连接**使用。
  dotenv 不覆盖已存在的环境变量，因此生产由部署平台注入的值优先，且生产不需要这个文件。

本地最小内容：

```bash
# 基础设施：凭据与端口，供 compose 创建容器
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
REDIS_PASSWORD=<REDIS_PASSWORD>
MINIO_ROOT_PASSWORD=<MINIO_ROOT_PASSWORD>

# 应用：连接串与密钥，供应用读取
DATABASE_URL=postgres://admin:<POSTGRES_PASSWORD>@localhost:5432/red_bean?sslmode=disable
REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:6379/0
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=<MINIO_ROOT_USER>
MINIO_SECRET_KEY=<MINIO_ROOT_PASSWORD>
JWT_SECRET=local-development-secret-change-before-production
LLM_API_KEY=sk-...
```

以上凭据仅适用于本地 Compose。生产环境必须使用独立密钥、TLS 和安全的配置注入方式。

完整配置说明见 [配置参考](#-配置参考)。

### 4. 初始化数据库

```bash
make db-migrate
```

### 5. 启动服务

```bash
make run
# 服务默认运行在 http://localhost:8080
```

或者直接使用 package 脚本：

```bash
pnpm install --frozen-lockfile  # 仓库根执行：workspace 单 lockfile 全仓安装
pnpm build
pnpm start
```

## 🛠️ 开发

### 可用命令

```bash
make help           # 查看所有命令
make run            # 构建并运行 TypeScript server
make backend-ts-verify # TypeScript 后端格式、类型、Lint、测试与构建
make be-test         # TypeScript 后端测试
make be-typecheck    # TypeScript 后端严格类型检查
make be-lint         # TypeScript 后端类型感知 ESLint
make be-format       # 格式化 TypeScript 后端
make contract       # TypeScript 后端与前端契约校验
make compose-check  # 静态检查 Compose 镜像、监听地址和凭据来源
make verify         # 完整门禁（TS 后端、前端、DS 与 sibling SDK）
make verify-full    # 发布前再加真实基础设施集成测试与依赖审计（读取 .env）

# 数据库
make db-migrate     # 执行迁移(up)
make db-status      # 查看迁移状态
make db-rollback    # 回滚最后一次迁移

# 基础设施
make infra-up       # 启动 Docker Compose
make infra-down     # 停止并清理容器
make infra-logs     # 查看容器日志
```

### 项目结构

```
backend/
├── src/
│   ├── entrypoint/       # server / migrate 进程入口
│   ├── app/              # 顶层 composition root、HTTP 装配与资源生命周期
│   ├── modules/          # agent、task、identity、storage、system 业务模块
│   ├── platform/         # LLM、Tool Provider 与可观测性平台适配
│   ├── infra/            # 配置、PostgreSQL、Redis、日志与底层客户端
│   └── shared/           # 跨模块稳定共享的 HTTP、错误和基础类型
├── test/                 # 按生产能力镜像组织的单元、契约与真实集成测试
├── package.json          # 构建、测试、Lint 与运行脚本
├── docs/
│   └── standards/        # 编码规范、开发流程
├── Makefile              # 任务自动化
├── docker-compose.yml    # 本地基础设施
├── .env.local.example    # 本地配置模板（提交到 git）
├── .env.local            # 本地配置唯一来源（不提交）
└── config.yaml           # 非密默认值基线（提交到 git）
```

详细分层说明见 [后端架构设计](../docs/design/backend/architecture.md)。

## ⚙️ 配置参考

配置由 `src/infra/config/config.ts` 读取 `config.yaml`，再逐字段套用环境变量（本地来自
`backend/.env.local`）。所有外部值会在启动前显式解析和校验。

| 配置路径 | 说明 | 本地示例 / 要求 |
|---------|------|--------|
| `database.url` | PostgreSQL 连接串 | 必填；用户名、密码和端口与 `.env.local` 的基础设施键一致 |
| `database.auto_migrate` | 应用启动时自动执行 migration | 本地可为 `true`；生产必须为 `false` 并使用独立 migrate job |
| `redis.url` | Redis 连接串 | 必填；密码和端口与 `.env` 一致 |
| `jwt.secret` | JWT 签名密钥 | 必填；生产至少 32 字节，禁止占位值 |
| `server.host` | HTTP 监听地址 | `0.0.0.0`；生产由部署平台或网关控制暴露范围 |
| `server.port` | HTTP 端口 | `8080` |
| `server.env` | 环境标识 | `local` |
| `server.log_format` | 日志格式(text/json) | `text` |
| `server.log_level` | 日志级别(debug/info/warn/error) | `info` |
| `cors.origins` | 允许的跨域来源 | `http://localhost:5173` |
| `minio.endpoint` | MinIO 地址 | `localhost:9000` |
| `minio.access_key` | MinIO 访问密钥 | 必填；与 `.env` 的 `MINIO_ROOT_USER` 一致 |
| `minio.secret_key` | MinIO 密钥 | 必填；与 `.env` 的 `MINIO_ROOT_PASSWORD` 一致 |
| `minio.bucket` | 存储桶名称 | `red-bean-nian-gao` |
| `llm.api_key` | LLM API 密钥 | - |
| `llm.base_url` | LLM API 端点 | `https://api.deepseek.com/v1` |
| `scheduled_task.batch_size` | 每轮扫描任务上限 | `100` |
| `scheduled_task.max_concurrent` | scheduler 最大并发数 | `4` |
| `scheduled_task.execution_timeout` | 单次执行超时 | `15m` |
| `observability.exporter` | Trace 后端 | `structured`（默认）或 `otlp` |
| `observability.service_name` | OTel `service.name` | `red-bean-nian-gao`；可由 `OTEL_SERVICE_NAME` 覆盖 |
| `observability.sample_ratio` | 本地新 Trace 采样率 | `(0, 1]`；可由 `OTEL_TRACES_SAMPLER_ARG` 覆盖 |
| `dev_user.username` | 本地默认用户 | 留空则不创建 |
| `dev_user.password` | 本地默认密码 | 留空则不创建 |

完整配置见 [`config.yaml`](config.yaml)。

### LLM Provider 扩展

`llm_configs.provider` 由 `src/platform/llm` 的封闭 Registry 解析。当前静态注册 `openai` Provider，
使用 Runtime SDK 的 OpenAI-compatible Adapter，因此 DeepSeek 继续通过 `provider=openai` 配合
`llm.base_url=https://api.deepseek.com/v1` 使用，无需迁移配置。

新增 Provider 时，实现 `src/platform/llm/registry/llm-registry.ts` 的 `LlmProviderPlugin` 并在
`src/app/composition-root.ts` 显式注册；插件只构造 Adapter，
不读取数据库或全局配置。Registry 完成启动注册后不可变，业务 Loader 继续只依赖 Runtime 的
`LLMAdapterFactory`。

### Tool Provider 扩展

工具由 `src/platform/tool` 的静态 Provider 插件注册：Runtime builtin 与产品 builtin 分开提供，
Registry 构建后封闭，`DbMainAgentLoader` 只接收只读 Tool Catalog。新增工具应加入归属明确的
Provider 插件；需要数据库或外部服务的依赖由插件构造函数显式注入。

注册工具不会自动授权给 Agent。只有产品确实需要默认开放时，才同步调整 bootstrap 中的
`defaultAgentToolIDs`；文件读取、HTTP 请求等能力必须继续单独审查安全边界。

### 模型切换与部署更新

LLM Registry 固定的是 Provider 协议实现，而不是具体模型。`DbMainAgentLoader` 在一次运行开始时读取
Agent 的模型、端点、凭据和参数并创建 Adapter；因此更新这些配置后，下一次运行自动使用新值，已经
开始的流式运行继续使用原 Adapter。新增未实现的 Provider 协议或静态工具时，需要改代码、重新构建并
部署服务。

核心 server 不在自身进程内安装代码或替换能力图。生产部署应构建带有 `/version` 元数据的不可变产物，
以 `/health`、`/readyz` 和 `/version` 验证新实例，再由编排平台滚动替换旧实例；应用自身负责优雅退出。

## ❓ 常见问题

<details>
<summary><strong>启动时报 "database.url 未设置"</strong></summary>

确保 `config.yaml` 或 `.env.local` 的 `DATABASE_URL` 提供了 `database.url`:

```yaml
database:
  url: postgres://admin:<POSTGRES_PASSWORD>@localhost:5432/red_bean?sslmode=disable
```

如果容器未启动:
```bash
make infra-up
docker compose ps  # 确认 red_bean_postgres 状态为 healthy
```
</details>

<details>
<summary><strong>启动时报 "jwt.secret 仍为示例值"</strong></summary>

`.env.local` 的 `JWT_SECRET` 不能是 `change-me-to-a-long-random-string`，必须改成实际密钥:

```bash
# backend/.env.local
JWT_SECRET=my-super-secret-key
```
</details>

<details>
<summary><strong>Docker 服务启动失败或端口冲突</strong></summary>

```bash
# 清理旧容器
make infra-down

# 检查端口占用(macOS/Linux)
lsof -i :5432  # PostgreSQL
lsof -i :6379  # Redis
lsof -i :9000  # MinIO

# 重新启动
make infra-up
```

如果端口被占用，修改 `.env.local` 的宿主机端口（`POSTGRES_PORT` 等），**并同步更新同一文件里的连接地址**（`DATABASE_URL` 等）——两者现在同处一个文件，改动只在一处。
</details>

<details>
<summary><strong>迁移执行失败 "table already exists"</strong></summary>

数据库中已有表但迁移记录丢失。最简单的方式是删库重建:

```bash
# 方式 1: 通过 psql
psql -U admin -h localhost -c "DROP DATABASE red_bean;"
psql -U admin -h localhost -c "CREATE DATABASE red_bean;"

# 方式 2: 重建 Docker 容器（会删除本地 PostgreSQL、Redis 和 MinIO 数据）
docker compose --env-file .env down -v
make infra-up

# 重新执行迁移
make db-migrate
```
</details>

<details>
<summary><strong>如何调试请求链路</strong></summary>

项目已把 HTTP Request ID、Run ID 和 Trace ID 分开，并通过启动期注入的观测包装器输出结构化 span 日志：

1. **发起请求时携带 X-Request-ID 头**（可选，网关/前端生成）。若已有上游 Trace，也可携带合法
   W3C `traceparent`；服务会继承其 Trace ID 和采样决定：
   ```bash
   curl -i \
     -H "X-Request-ID: my-test-123" \
     -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
     http://localhost:8080/health
   ```

2. **查看响应头**：`X-Request-ID` 对应本次 HTTP 请求，`X-Trace-ID` 对应完整执行链；聊天 SSE 的
   `start.request_id` 是取消用 Run ID，`start.trace_id` 与响应头 Trace ID 相同。

3. **查看日志**，请求内日志自动带 `request_id` / `trace_id`，span 另带 `span_id` 和
   `parent_span_id`；子 Agent 会产生 `agent.delegate`，其模型和工具 span 挂在该节点下：
   ```bash
   # JSON 模式(便于日志系统解析)
   SERVER_LOG_FORMAT=json make run

   # 输出示例
   {"time":"...","level":"INFO","msg":"span.end","request_id":"REQ_...","trace_id":"...","span_id":"...","span.name":"pipeline.run"}
   ```

默认 `structured` 模式不建立外部连接。启用 OTLP/HTTP 时设置 `observability.exporter: otlp` 或
`OBSERVABILITY_EXPORTER=otlp`，再用标准 `OTEL_EXPORTER_OTLP_ENDPOINT`、
`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_EXPORTER_OTLP_INSECURE` 等环境变量配置 Collector。业务 handler、
Pipeline 和工具无需改动；进程关闭时应用 lifecycle 会刷新并关闭 exporter。详见
[可观测性设计](../docs/design/backend/observability.md)。
</details>

## 📖 文档

- [STACK.md](STACK.md) — 技术栈与选型理由
- [AGENTS.md](../AGENTS.md) — 跨客户端 AI 协作开发规范的唯一入口
- [docs/standards/](./docs/standards/) — 编码规范、开发流程
- [生产发布检查清单](../docs/guides/production-readiness.md) — 上线门禁、配置、安全、扩容和回滚检查
- [产品设计文档](../docs/design/) — pipeline/tool/session 等模块设计
