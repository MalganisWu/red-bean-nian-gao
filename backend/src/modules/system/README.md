# System Module

负责 `/health`、`/readyz` 和 `/version`，不负责创建数据库、Redis 或对象存储连接。

## 阅读入口

```text
http-api.ts
→ controller/health.routes.ts
→ controller/health.controller.ts
→ service/health/port/health-service.port.ts
→ service/health/default-health-service.ts
→ system.module.ts
```

模块顶层分为 `controller/`（HTTP）与 `service/`（业务）平级两大块；`service/health/` 子域内
接口集中在 `port/` 目录，实现类 `HealthService` 平铺在子域目录下（跨模块真边界，`implements
HealthServicePort`）。

Routes 只绑定 method/path，`HealthController` 负责 HTTP 状态与响应映射。`HealthServicePort` 是部署探针边界；
默认实现 `HealthService` 并行执行数据库、Redis、对象存储
检查并感知应用 draining 状态。`createSystemModule()` 在模块内完成 Port → 默认实现绑定，
`app/composition-root.ts` 只注入基础设施检查函数和构建版本。

一致性约束：`/health` 仅表示进程存活；`/readyz` 在依赖异常或应用排空期间返回 503；
`/version` 必须由部署环境注入版本、提交和构建时间，才能证明当前运行代码。

对应测试位于 `test/modules/system/controller/`、`test/modules/system/service/health/` 与 `test/entrypoint/`。
