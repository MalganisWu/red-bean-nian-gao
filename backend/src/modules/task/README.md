# Task Module

负责任务配置、执行历史、调度和结果投递。模块顶层分为 `controller/`（HTTP）与 `service/`（业务）两大块，
`service/` 下按职责分组：`cases/`（HTTP 用例）、`scheduling/`（调度）、`delivery/`（投递）、
`tool/`（工具）、`persistence/`（PostgreSQL 仓储）与 `error/`（领域错误与错误包装）。

## HTTP 用例链

```text
http-api.ts
→ controller/task.routes.ts
→ controller/task.controller.ts
→ service/cases/TaskQueryService + TaskCommandService（内部 1:1 实现类，无独立 Port）
   → service/persistence/*/port/*Repository（真边界）
   → service/persistence/*/PostgresTask*Repository
```

查询 Service 集中处理列表、详情、执行历史和资源所有权；命令 Service 集中处理启停、删除和视图状态。
Controller 只解析 HTTP 输入、调用用例 Service 并映射错误/响应。`TaskQueryService` 与
`TaskCommandService` 是内部 1:1 实现（已删除对应 Port），Controller 直接依赖实现类。

## 调度与投递链

```text
task.module.ts
→ service/scheduling/ScheduledTaskWorker（进程定时触发）
→ service/scheduling/port/TaskSchedulerPort（保留，测试有 fake）
→ service/scheduling/ScheduledTaskScheduler（扫描、并发与 lease）
→ service/scheduling/TaskExecutionService（内部 1:1，无 Port）
→ Agent BackgroundAgentExecutionPort
→ service/delivery/DeliveryQueue（实现 agent 跨模块边界 TaskResultDeliveryPort）
→ Agent ExternalSessionTurnWriterPort
```

`BackgroundAgentExecutionPort` 隐藏 Agent Loader、Runtime Executor、恢复缓冲和展示消息构建；
`ExternalSessionTurnWriterPort` 隐藏 Session Repository、lease/fencing、Checkpoint 追加与重复投递判断。
因此 Task 不直接 import Agent 的 Adapter 或内部模型，只通过 `agent/public-api.ts` 使用公开能力。
内部 1:1 的 Worker、投递能力均已删除独立 Port；`TaskExecutionService` 聚合"运行快照 → Agent 执行 →
落库/重试/投递"的完整流程在单个 `run` 方法内串联（含 span/traceId 包装），调度链中的类直接互相依赖；
跨链协作仍走保留的真边界（`TaskSchedulerPort`、Agent 的 Port、持久化仓储 Port）。

任务定义、执行记录、调度 lease、重试策略和投递确认仍由 Task Module 持有。生产实现绑定集中在
`task.module.ts`；`TaskExecutionService` 在此构造并注入 Scheduler，Service 不自行组装其他 Lifecycle。
跨 Module 接线集中在 `app/composition-root.ts`。

`createTaskPersistence()` 返回的预组装对象封装全部 Repository，不再把仓储暴露给 App 或 Tool Platform；
它只提供"创建定时任务管理工具"和"创建完整 Task Module"两个窄工厂能力。

定时任务执行与结果投递按 at-least-once 设计：执行记录和投递确认可由 fencing、幂等检查与 reconcile
保护，但 Runtime 内已经发生的外部工具副作用无法被数据库事务回滚，也不承诺 exactly-once。工具实现
仍须使用业务幂等键或目标系统自身的幂等能力处理重试。

持久化按 `TaskCommandRepository`、`TaskQueryRepository`、`TaskExecutionRepository`、
`TaskListRepository` 和 `ExecutionViewStateRepository` 标明角色（`service/persistence/*/port/`）。
当前 PostgreSQL Adapter 显式实现这些窄 Port；调用方只声明自己需要的能力，避免把大型 Adapter
误当成一个业务 Service。列表查询参数统一为"所有者在前"：`listBySession(userId, sessionId)`、
`listItemsBySession(userId, sessionId)`。

Task 只能消费 Agent `public-api.ts` 暴露的业务模型和窄 Port，不能直接依赖 Runtime SDK。Task 执行结果中的
`AgentJsonValue` 属于 Agent 产品域契约，不是 SDK `JsonValue` 的转发别名。
Task 对展示消息的 HTTP 投影与 PostgreSQL 写入共用
`service/persistence/task-display-message-presenter.ts` 的纯字段映射；Task 只消费 Agent 公开的
`DisplayMessage` 数据，不再向 Agent Module 索取 serializer 行为 Port。

## 测试入口

- HTTP、Query 与 Command 组合：`test/modules/task/controller/task-routes.test.ts`。
- 调度、执行、投递和持久化：`test/modules/task/service/{scheduling,delivery,persistence}/`。
- Tool 协议：`test/modules/task/service/tool/scheduled-task-tool.test.ts`。
- PostgreSQL migration 与持久化：`test/integration/postgres-migration.integration.test.ts`。
- Redis、MinIO 真实适配：`test/integration/redis-minio.integration.test.ts`。
- 完整应用与 HTTP/SSE：`test/integration/application-http.integration.test.ts`。

## 文件规模审查

`TaskController` 超过 Controller 的人工审查触发线，**门禁每次都会报**（`make be-architecture-check`
的 file-size-review 报的是当下行数，这里不复制）。保留的理由是职责而不是行数：它承载同一 HTTP 资源
下的薄 Query/Command 端点，请求解析、Wire Presenter 和业务规则已经分别在 `task-request-parser.ts`、
`task-presenter.ts` 与用例 Service。继续只按行数拆会分散同一资源的传输映射；增加新端点或重新引入
业务判断时，应优先按资源子域拆 Controller。
