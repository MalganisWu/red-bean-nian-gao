# 服务启动、自检与初始化

> 文档性质：活文档。描述当前服务进程在监听 HTTP 前完成的基础设施检查、数据库门禁和默认数据初始化。

## 启动顺序

`backend/src/entrypoint/server.main.ts` 加载并校验配置后调用 `backend/src/app/composition-root.ts`，应用按以下顺序启动：

```text
加载并校验配置
  → 连接并 PING PostgreSQL 与 Redis
  → 构造 MinIO client
  → EnsureBucket
  → bootstrapDatabase
      ├─ database.auto_migrate=true：执行未应用 migration
      ├─ database.auto_migrate=false：只读校验所有 migration 已应用
      └─ 幂等同步默认数据
  → 组装观测、Agent、工具、Scheduler、Fastify routes 与 HTTP Server
  → 启动 Scheduler、delivery reconcile（立即一次，此后每 30 秒）与 HTTP Server
```

`EnsureBucket` 位于 HTTP 监听之前，因为后续 `/readyz` 的对象存储 `Stat` 依赖目标 bucket 已存在。配置、连接、
bucket、连接自检、migration 或默认数据任一步失败都会阻止 HTTP Server 启动。只有投递队列 reconcile 是
可恢复的非阻塞步骤：失败条目保留，周期任务和后续入队会再次尝试。

收到进程信号后先把 readiness 标记为 draining 并优雅停止 HTTP，再取消并等待 Scheduler 与 reconcile；
后台任务完全退出后，应用 lifecycle 才逆序关闭观测 Provider、Redis 和 PostgreSQL。构建中途失败时
也会关闭已经创建并登记的资源。

## 基础设施检查

构建期连接与 `/readyz` 使用以下真实检查：

| 服务 | 检查方式 |
| --- | --- |
| PostgreSQL | 参数化连接池执行 `SELECT 1` |
| Redis | 客户端连接后执行 `PING` |
| 对象存储 | 对 `.health-check` 执行 `Stat`；key 不存在视为连通 |

任一检查失败立即返回。当前 composition root 总是构造并检查 MinIO，不存在“配置为空则跳过对象存储”
的分支。

## Migration 门禁

`backend/src/app/bootstrap.ts` 根据 `database.auto_migrate` 选择模式：

- `true`：使用 TypeScript migrator 初始化历史表并应用尚未执行的 migration，适合本地开发。
- `false`：只读检查随二进制发布的 migration 是否全部应用；有遗漏即拒绝启动。生产 migration 应由
  独立 job 通过 `backend/src/entrypoint/migrate.main.ts`（`make db-migrate`）执行，避免多个应用副本并发 DDL。

迁移目录是 `backend/src/infra/database/migrator.ts` 的 `MIGRATIONS` 冻结数组（随二进制编译发布，
不存在独立的 `backend/migrations/` 目录）。TypeScript migrator 继续读写 Bun 创建的
`bun_migrations` / `bun_migration_locks`，并验证记录是冻结数组的合法前缀。已有历史不会重放；
新 migration 必须追加定义，不修改已经执行的历史 migration。

## 默认数据

`seedDefaults`（`backend/src/app/bootstrap.ts`）每次启动都运行，通过固定 ID、`ON CONFLICT` 或集合更新
保持幂等，依次同步：

1. 默认 OpenAI API credential（`CRED_default_001`，从配置取 base URL 与 key）。
2. 引用该 credential 的默认 LLM 配置（`LLMC_default_001`）。
3. 默认 executor Agent（`default`，`sys_tool_ids` 置空创建）。
4. 把 `DEFAULT_AGENT_TOOL_IDS` 并入该 Agent 的 `sys_tool_ids`，并 `array_remove` 掉历史上自动授予的
   `sys_fetch_url` / `sys_http_request` / `sys_read_file`。
5. `seedDefaultUser`：仅在同时配置 `DEV_USERNAME` 与 `DEV_PASSWORD` 时创建开发用户。

默认 Agent 自动获得 `sys_get_time`、`sys_scheduled_task_manage`、`sys_ask_user` 和 `sys_shell`。第 4 步的
授权集合只有一个来源——`DEFAULT_AGENT_TOOL_IDS`；只改数据库会在下次启动时被并集覆盖。`sys_fetch_url`、
`sys_http_request` 与 `sys_read_file` 仍可显式配置给专用 Agent，但不属于默认权限。

新增默认数据时，应在 `seedDefaults` 中显式调用独立的 `seed*` 辅助函数（现有 `seedDefaultUser` 是范例），并满足：

- 重复启动不会创建重复记录或扩大权限。
- 已存在的用户配置不会被无条件覆盖；若需要收敛安全默认值，写清楚移除规则。
- 错误包含具体初始化步骤，并向上返回以阻止不完整实例启动。
- 生产必需数据与仅由 `DEV_*` 配置启用的开发便利数据明确分开。

## 投递恢复

首次 `DeliveryQueue.ReconcileAll` 在默认数据完成后、HTTP 监听前执行。它扫描未投递的定时任务执行，
按 session 补入 Redis FIFO，并尝试在独立 session lease 内投递。失败不会阻止启动，后台每 30 秒重试；
详情见 [`../agent/scheduled-task.md`](../agent/scheduled-task.md)。

## 变更检查

修改启动顺序、基础设施依赖、migration 策略、默认权限或 seed 内容时，同时检查：

- 根 `README.md` 与部署环境变量说明。
- [`../../guides/production-readiness.md`](../../guides/production-readiness.md)。
- [`../backend/architecture.md`](../backend/architecture.md)。
- 默认数据和启动门禁对应测试。
