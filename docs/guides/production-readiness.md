# 生产发布检查清单

> 文档性质：活文档。每次生产发布逐项确认；部署、安全或运行方式变化后必须同步审查，
> 未满足“发布阻塞项”时不得上线。
>
> 本清单属于产品宿主。Runtime SDK 只提供中性的运行、checkpoint 与 CAS/fencing 契约，
> 不负责部署拓扑、租约、数据库、Redis、密钥或网关配置。

## 发布阻塞项

- [ ] 仓库根目录 `make verify-full` 全绿，工作区无未解释的生成物或格式漂移。
- [ ] `backend/package.json` 中的 `red-bean-qing-tuan` 已解析为可复现的不可变产物；若发布系统仍使用
  sibling workspace，必须核对该 checkout 与 `runtime.lock` 的精确 commit 一致且不含未提交改动。
- [ ] `server.env=production`；数据库、Redis、MinIO、JWT 和 LLM 均由密钥系统或环境注入，不含 `CHANGE_ME`、本地 Compose 密码或提交到仓库的真实密钥。
- [ ] `jwt.secret` 至少 32 字节；CORS 只列出正式前端 origin，不使用通配符。
- [ ] PostgreSQL、Redis 与对象存储启用生产认证和传输加密；数据库连接不使用 `sslmode=disable`。
- [ ] 数据库已备份；migration 已在同版本预发布环境演练升级与回滚，由独立 job 执行 `make db-migrate`；生产实例设置 `DATABASE_AUTO_MIGRATE=false`，启动时只校验 schema 已是最新。
- [ ] `/health` 返回 200 `healthy`；`/readyz` 在依赖正常时返回 200 `ready`，依赖故障或排空时返回 503 `not_ready`。
- [ ] `/version` 的 `version`、`commit`、`built_at` 与发布记录一致；部署平台在接流量前确认候选实例探针和版本正确。
- [ ] 反向代理关闭 SSE 响应缓冲，空闲超时大于 15 秒 heartbeat 间隔，并保留 `X-Request-ID` 与 `X-Trace-ID`。
- [ ] storage 五条路由均要求 Bearer JWT；跨用户 `uploads/<user_id>/` key 返回 404，上传大小和预签名 TTL 上限测试通过。
- [ ] LLM 和 Tool Registry 的静态 Provider 与本次发布版本一致；Agent 的模型、端点和凭据配置已在预发布环境验证。

## 部署形态与一致性

- [ ] 明确本次是单实例还是多实例部署。
- [ ] 单实例部署：保证同一环境只有一个 scheduler 主动扫描任务，并监控 Redis session lock。
- [ ] 多实例部署：确认已启用唯一 lease owner、heartbeat/失租取消、数据库单调 fencing token、session revision CAS/fenced commit，以及任务投递 processing/reclaim；再通过真实多进程故障注入验收。
- [ ] 产品通过高层 `AgentRuntime.run/resume` 执行，但由业务 `StoredRuntimeState` 单份持久化 checkpoint；
  session lease、交互状态与 CAS 保护 answer 恢复，若未来采用独立 `CheckpointStore` 再补 Resume claim 超时接管。
- [ ] 不把普通 Redis mutex 描述为 exactly-once。锁降低并发概率；CAS/fencing 防止旧 owner 回写；外部副作用仍需幂等或 outbox。
- [ ] Redis、数据库和对象存储的容量、TTL、备份、恢复目标与故障告警已经配置。

## 可观测性与安全

- [ ] 日志使用 JSON，生产日志级别合理；可按 trace ID、run ID、session ID 定位一次运行，并确认
  `http.request → agent.load/agent.execute → llm.stream/tool.execute` 层级可检索。
- [ ] 明确选择 `structured` 或 `otlp`。使用 OTLP 时，Collector endpoint、TLS、认证和网络策略通过标准
  `OTEL_EXPORTER_OTLP_*` 环境变量配置，`service.name`、环境和采样率符合当前部署，并验证优雅停机
  能在超时内刷新 exporter。
- [ ] 用合法 `traceparent` 冒烟确认 `X-Trace-ID` 继承上游 Trace ID；用非法 header 确认服务生成新的
  32 位 ID。响应不得回显 `traceparent`，该 header 不参与认证、幂等或取消。
- [ ] SSE 未捕获错误只返回业务码 `5000` 和安全文案，内部错误仅进入服务端日志。
- [ ] 登录、刷新、聊天、answer、cancel、storage 和任务写接口配置速率限制或上游配额。
- [ ] 管理端、MinIO console、数据库和 Redis 不直接暴露公网。
- [ ] 已检查依赖漏洞、镜像来源与许可证；镜像和模块版本均固定，避免生产使用浮动 `latest`。

## 冒烟与回归

- [ ] 注册/登录/刷新/登出与用户隔离。
- [ ] 普通对话、Reason、Tool 成功/失败、子 Agent、QuestionCard answer/refuse、cancel 和断线恢复。
- [ ] 长连接 heartbeat、上下文 compaction，以及 status 重试 payload 与 `docs/contracts/api.md` golden 一致。
- [ ] 会话历史保存/刷新、定时任务创建/启停/执行/结果投递、执行视图状态。
- [ ] 文件上传、下载、删除、GET/PUT presign 的本人访问与跨用户拒绝。
- [ ] 前端 Light/Dark、桌面/移动端、错误/空/加载态和浏览器控制台无异常。
- [ ] 修改模型配置后确认下一次新运行使用新模型；已开始的 SSE 流继续使用开始时创建的 Adapter。

## 发布与回滚

- [ ] 记录应用版本、Runtime package/commit、migration 版本、配置版本和镜像 digest。
- [ ] 先小流量实例，通过 `/readyz` 后再扩容；下线时先进入 draining，再等待在途 SSE 和任务退出。
- [ ] 回滚方案区分“只回滚应用”和“需要数据库 down migration”；不得在未确认数据兼容性时自动回滚 migration。
- [ ] 发布后观察错误率、SSE 中断率、LLM/Tool 延迟、scheduler 重复执行、锁冲突、队列积压和存储错误。

## 部署更新

产品实例启动后能力图固定：不会在进程内安装 Tool/LLM Provider、构建 Generation 或替换 Runtime。发布
新的 Provider 协议、工具实现、Runtime 版本或任意后端代码时，构建新的不可变产品产物，并由部署平台
创建候选实例。

部署平台在接流量前必须检查候选的 `/health`、`/readyz` 和 `/version`，并在下线旧实例时发送终止信号。
应用收到信号后停止接收新请求、让 `/readyz` 返回 draining、等待在途 SSE、任务和资源关闭；平台应给予
足够的优雅退出时间。Kubernetes 等编排平台可采用滚动更新；当前单机环境可接受受控重启。

升级前必须先独立执行兼容 migration。应用回滚与数据库 down migration 是独立决策；若 schema 不向后
兼容，禁止自动把应用切回旧版本。

## 当前已知发布缺口

- Runtime 目前由 `backend/package.json` 的 sibling `link:../../red-bean-qing-tuan` 接入；独立 checkout、
  容器或发布构建前必须完成 package 发布/打包，或由构建系统显式提供并验证同版本 workspace。
- 后端已实现聊天与 scheduler 的唯一 lease owner、续期/失租取消、数据库 sequence fencing、session revision CAS，以及任务投递的 queue→processing→ack、execution ID 去重和周期 reconcile；仍需在可用的 PostgreSQL/Redis 与至少两个服务实例上完成故障注入验收。
- 产品已提供可选 OTLP/HTTP exporter、ParentBased 采样和入站 W3C Trace Context；仓库不内置
  Collector、Trace 存储、看板或告警，正式环境仍需部署并验证这些外部设施。
- 上述机制保护状态提交并提供任务投递 at-least-once，不保证任意外部工具副作用 exactly-once；有副作用的工具仍需按 `RequestID + CallID + revision/fence` 实现幂等或事务型 outbox。
- 尚未提供生产容器编排清单；当前 `docker-compose.yml` 已收紧本地默认值，但只用于开发。
