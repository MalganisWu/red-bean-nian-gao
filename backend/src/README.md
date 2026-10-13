# 后端人工代码审查导航

本页是从 HTTP 接口追到业务实现和基础设施的首选入口。整体关系可类比 Java 项目的
`Controller → Application Service → Port → Adapter`。区别是对象统一在 Module 组装文件中创建，
Controller 只持有接口，所以调用处不会现场 `new` 具体实现。

## 代码结构

```text
src/
├── entrypoint/              server / migrate 薄进程入口
├── app/                     全局 Composition Root、HTTP 与生命周期
├── modules/
│   ├── agent/               Chat、Session、Runtime 执行与 Sub-Agent
│   ├── task/                任务配置、调度、执行历史与结果投递
│   ├── identity/            用户、认证与密码散列
│   ├── storage/             对象存储
│   └── system/              健康检查与版本信息
├── platform/                LLM / Tool Provider 与启动期 Registry
├── shared/                  跨模块 HTTP 等薄共享机制
└── infra/                   配置、数据库、Redis、日志、观测与 ID
```

每个业务 Module 内按能力再分小目录；接口放 `port/`，默认实现放 `service/`，外部系统实现放
`adapter/`。`<module>.module.ts` 负责 Module 内 `Port → 实现`，`public-api.ts` 是业务跨 Module 的唯一入口；
仅 `app/http-routes.ts` 可通过 `<module>/http-api.ts` 组装 HTTP driving adapter。

## 从接口找到默认实现

固定使用下面四步，不依赖猜文件名：

```text
依赖字段
→ 打开字段类型对应的 Port
→ 搜索 implements <PortName>
→ 在 <module>.module.ts 查看 new ConcreteClass(...)
→ 必要时在 app/composition-root.ts 查看跨 Module 接线
```

例如 `/api/agent/chat`：

```text
modules/agent/chat/controller/chat.routes.ts
→ ChatController
→ ChatUseCasePort
→ DefaultChatService implements ChatUseCasePort
→ agent.module.ts: new DefaultChatService(...)
→ AgentRunServicePort
→ ProductAgentRunService implements AgentRunServicePort
→ ProductAgentRunService.start(...)
→ ChatRunHandle（events / completion / close）
```

`app/composition-root.ts` 只创建基础设施、平台 Registry 和各 Module，并处理 Agent/Task 的双向业务协作；
Module 内的实现选择不再堆在全局组装根中。这里使用两级组装：第一层由各 `*.module.ts` 绑定模块内部
`Port → 默认实现`，第二层由全局 Composition Root 连接模块公开能力。Agent/Task 又按
`createAgentModuleCore → createTaskModule → createAgentModule` 分阶段组装，避免源码层形成循环依赖。

## `/api/agent/chat` 完整链路

```text
modules/agent/http-api.ts
→ chat.routes.ts
→ chat.controller.ts
→ ChatUseCasePort / default-chat-service.ts
→ AgentRunServicePort
→ default-agent-run-service.ts
→ SessionRunServicePort / AgentExecutionPort
→ default-session-run-service.ts / runtime-agent-executor.ts
→ red-bean-qing-tuan AgentRuntime
→ ChatRunObserver + chat-stream.ts
→ SSE
```

逐文件阅读顺序：

1. `modules/agent/chat/controller/chat.routes.ts`：只绑定 URL、鉴权和 Controller。
2. `modules/agent/chat/controller/chat.controller.ts`：解析请求并只调用 `ChatUseCasePort`。
3. `modules/agent/chat/port/chat-use-case.port.ts` 与
   `modules/agent/chat/service/default-chat-service.ts`：聊天入口编排、ID、取消注册和活动运行所有权。
4. `modules/agent/run/port/agent-run-service.port.ts` 与
   `modules/agent/run/service/default-agent-run-service.ts`：单次 Agent 运行主链。
5. `modules/agent/session/run/port/session-run-service.port.ts` 与
   `modules/agent/session/run/service/default-session-run-service.ts`：Session 加载、锁、保存和投递。
6. `modules/agent/execution/port/agent-executor.ts` 与
   `modules/agent/execution/adapter/runtime-agent-executor.ts`：产品状态与 Runtime SDK 的唯一适配边界。
7. `modules/agent/agent.module.ts`：上述 Port 的生产实现绑定。
8. `app/composition-root.ts`：Agent、Task、Identity、Storage、System 与基础设施的最终连接。

## 功能调用链

| 功能               | HTTP 入口                  | Application Service                                                                             | 主要 Port / Adapter                                                                                           | Module 组装                   |
| ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 聊天、回答、取消   | `agent/chat/controller`    | `agent/chat/service/default-chat-service.ts` → `agent/run/service/default-agent-run-service.ts` | `ChatUseCasePort`、`AgentRunServicePort`、`SessionRunServicePort`、`RuntimeAgentExecutor`、Redis cancellation、`RunFactRepository`（session_runs 事实日志写入） | `agent/agent.module.ts`       |
| 会话列表与详情     | `agent/session/controller` | `agent/session/query/service/default-session-query-service.ts`                                  | `DefaultSessionQueryService`（内部 1:1）、`SessionRepository` / PostgreSQL adapter                             | `agent/agent.module.ts`       |
| 会话轨迹（审计）   | `agent/trajectory/controller` | `agent/trajectory/service/default-trajectory-service.ts`（内部 1:1）                          | `RunFactRepository` / PostgreSQL adapter、`SubExecutionRepository`；有 run 记录从 `session_runs` 投影，否则回退 display_messages | `agent/agent.module.ts`       |
| 定时任务与执行历史 | `task/controller`          | `task/service/{cases,scheduling,delivery,tool,persistence}`                                     | Task Repository、`BackgroundAgentExecutionPort`、`ExternalSessionTurnWriterPort`                              | `task/task.module.ts`         |
| 用户与认证         | `identity/controller`      | `identity/service/application/{registration,profile}`（内部 1:1 实现类，无 Port）               | Auth Service（`AuthServicePort` 真边界）、User Repository、Password Hasher                                    | `identity/identity.module.ts` |
| 对象存储           | `storage/controller`       | `storage/service/application/storage-service.ts`（内部 1:1，无 Port）                           | Storage Service、Object Storage / MinIO adapter                                                               | `storage/storage.module.ts`   |
| 健康检查           | `system/controller`        | `system/service/health`                                                                         | Health Service Port                                                                                           | `system/system.module.ts`     |
| Sub-Agent          | 聊天工具触发               | `agent/subagent/run/service`                                                                    | Runtime ChildRunner、AgentExecutionPort、Sub-execution repository                                             | `agent/agent.module.ts`       |

各 Module 的 `README.md` 提供该模块更细的阅读顺序。

## Task 与 Agent 的边界

Task 不再读取 Agent 的 Loader、Executor、MessageBuffer、Session Repository 或展示构建器。它只通过
`agent/public-api.ts` 获得四项窄能力：

- `BackgroundAgentExecutionPort`：执行一次后台 Agent，并返回已经按统一规则构建的展示消息。
- `ExternalSessionTurnWriterPort`：把任务结果作为外部回合写入 Session；锁、fencing、去重、Checkpoint
  追加和待交互判断全部留在 Agent Module。
- `SessionLockRegistry`：Scheduler 获取任务关联 Session 的协调能力。
- `task/presentation/task-display-message-presenter.ts`：让 Task HTTP 投影与持久化复用本模块唯一的
  展示字段规则，不跨模块依赖 Agent serializer。

反方向上，Agent 普通对话只依赖 Task 暴露的 `TaskResultDeliveryPort`。全局 Composition Root 先创建
Agent 核心能力，再创建 Task，最后把 Task 的投递能力接回完整 Agent Module。这是组装时的有向接线，
不是两个 Module 在源码中互相深层 import。

## DTO 与边界

- HTTP/SSE 机器契约只定义在 `../../api-contract/src/<domain>/`；Module 内 `controller/*.dto.ts` 只做
  type re-export，不含函数、Schema 或业务规则。
- 输入校验放在共享 validator 或 `*-request-parser.ts`，领域到 wire 的映射放 `*-presenter.ts`。
- Module model、Service command/result、Repository Port 与持久化 row 各自属于不同边界，不复用 HTTP DTO。
- PostgreSQL row mapper、Redis JSON codec 和 Runtime checkpoint codec 位于对应 adapter 附近。
- 产品 Session、恢复缓冲、展示与跨 Module Port 使用业务自有 `AgentMessage`、`AgentJsonValue` 和
  `DisplayMessage`；它们不是 SDK DTO 的别名。Runtime Adapter 在边界处与 SDK Message/Event/Checkpoint
  显式转换，业务仓只持久化自己的模型和不透明 `StoredRuntimeState.payload`。
- Runtime 的工具、模型 Adapter 等执行依赖只允许出现在 Agent Module 的执行/装载/平台适配边界，不能从
  `public-api.ts` 通过业务 Model 或 Port 泄漏到 Task 等其他 Module。

## 常用定位命令

```bash
rg -n "server\.(get|post|put|delete)" backend/src/modules
rg -n "export interface .*Port|export interface .*Repository" backend/src/modules
rg -n "implements .*Port|implements .*Repository|implements .*Adapter" backend/src
rg -n "new [A-Z]" backend/src/modules/*/*.module.ts backend/src/app/composition-root.ts
rg -n "describe\(" backend/test
```

## 架构机械门禁

运行 `make be-architecture-check` 或在后端目录运行 `pnpm architecture:check`。该快速、只读检查会拒绝：

- Controller 直接依赖 Repository / Adapter。
- 跨 Module 绕过目标模块 `public-api.ts` 的深层 import。
- `platform/shared/infra` 深层导入业务 Module，或业务 Module 反向依赖 `app`。
- Composition Root 中使用但未显式 `implements` 对应 Port 的生产默认实现。
- `adapter/` 中导出的生产类未显式 `implements` 对应 Port。
- `public-api.ts` 通过公开 Model/Port 转发 Runtime SDK 类型。
- `public-api.ts` 导出 Controller/Routes，或 `*.routes.ts` 自行构造 Controller。
- `public-api.ts` 直接或经 Module 返回类型间接暴露 Repository、ObjectStorage、Adapter 或 serializer。
- Wire DTO 出现函数、Schema、类或其他运行时值。
- Port 的 JSDoc 未说明默认实现，或缺少流/资源所有权、取消与失败语义。

Routes、Controller、主 Service 与 Adapter 超过建议行数时只输出人工审查提示，不因行数单独阻断构建。

- 白名单外的生产源码直接导入 `red-bean-qing-tuan`；白名单仅包含 Agent Runtime Adapter、platform
  LLM/Tool/Observability 和全局 composition root。
- 恢复已退役的 `src/api|engine|cli` 或 `test/api|engine|cli` 目录。
- Module 级循环依赖。

该检查已经接入 `make verify-quick` 与完整的 `backend-ts-verify`；规则回归测试位于
`test/architecture/`。
