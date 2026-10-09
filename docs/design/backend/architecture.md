# 产品后端架构

> 文档性质：活文档。描述当前 `backend/` 的模块、依赖方向以及与 Runtime SDK 的边界。

## 定位

后端是 `red-bean-nian-gao` 的产品宿主：提供 HTTP/SSE、认证、会话、定时任务、文件存储以及
产品展示投影。通用模型—工具运行能力来自同级仓库 `red-bean-qing-tuan`。

产品统一通过业务 `AgentExecutionPort` 调用 Runtime 高层 `AgentRuntime.run/resume`。业务后端的
`RuntimeAgentExecutor implements AgentExecutionPort` 是唯一 SDK 状态适配器；Session、数据库事务、
Redis 消息缓冲、分布式 lease 和 DisplayMessage 仍由产品生命周期管理。

产品本身就是 Harness，而不是在产品内部再嵌套一个 Harness 子系统。Runtime 是产品的必需执行 SDK，
HTTP、Session、展示、调度和基础设施继续属于宿主；观测等横切能力通过 Runtime decorator 接入。
LLM Provider 使用独立的启动期封闭 Registry 组合；它向 Agent Loader 只暴露 Runtime SDK 的中性
`LLMAdapterFactory`，不把具体 Adapter 或 Provider 查找扩散到业务层。
Tool Provider 也先注册并封闭；Runtime builtin 与产品 builtin 分离，Agent Loader 只依赖只读 Tool
Catalog，注册能力与 Agent 默认授权保持独立。每个后端实例在启动期完成这张能力图的组装；实例运行期间
不安装 Provider、不重建 Registry，也不在请求之间切换能力图。

## 代码结构

```text
backend/
├── src/
│   ├── entrypoint/             server / migrate 薄进程入口
│   ├── app/                    全局 composition root、HTTP adapter 与资源生命周期
│   ├── modules/
│   │   ├── agent/              Chat、Session、Runtime 执行与 Sub-Agent
│   │   ├── task/               任务配置、调度、执行历史与投递
│   │   ├── identity/           用户、认证与密码散列
│   │   ├── storage/            对象存储
│   │   └── system/             健康检查与版本信息
│   ├── platform/               LLM / Tool Provider 与启动期 Registry
│   ├── shared/                 跨模块 HTTP 等薄共享机制
│   └── infra/                  配置、PostgreSQL、Redis、日志、观测与 ID
└── test/                       单元、契约与真实基础设施集成测试
```

## 分层与依赖方向

### 依赖方向

- `src/modules/*/**/controller` 是与 Fastify 解耦的 HTTP 用例控制器：方法签名即"入参 + 返回"（入参
  DTO/标量与 `AbortSignal`），负责 wire DTO 投影和 HTTP 应用错误映射，但不导入 Fastify 类型、不自行连接
  基础设施。`*.routes.ts` 承载请求解包
  （parser、Principal/Bearer 提取、AbortSignal）、成功信封（`shared/http/response.ts` 的 `sendOk`）
  与 SSE/下载流的传输投影，同样不连接数据库、Redis 或 MinIO。
- `src/modules` 持有领域模型、Port、Adapter 和产品编排；业务跨 Module 只依赖 `public-api.ts`。
  `app/http-routes.ts` 可通过各 Module 的 `http-api.ts` 组装 Controller 与路由，这是唯一 transport 例外。
- `src/platform` 持有启动期封闭的 LLM / Tool Registry 与 Provider，不包含产品用例；产品工具实例由各
  Module 工厂创建，再由 composition root 注入 Tool Provider。
- `src/infra` 实现配置、PostgreSQL、Redis 和观测适配，不包含业务决策，也不实现业务 Module 内部 Port。
- `src/shared` 只定义中性机制与窄 Port，不依赖业务 Module；业务 Module 也不得反向依赖 `src/app`。
- `src/app` 是唯一完整组装层，可以依赖具体实现；`src/entrypoint` 只保留进程入口。
- 跨模块只依赖 `public-api.ts` 暴露的业务自有模型和窄接口。SDK 中性类型停留在 Agent Runtime Adapter、
  Loader 与平台接入边界，不通过产品 Model/Port 扩散；Fastify、`pg`、Redis、MinIO 或 OTel 具体类型同理。
- TypeScript 的边界由 import、类型检查、构造接线测试、架构机械门禁和人工架构审查共同保护。

直接导入 `red-bean-qing-tuan` 的生产白名单固定为 `modules/agent/execution/adapter/`、
`platform/{llm,tool,observability}/` 与 `app/composition-root.ts`。其余源码只依赖产品 Port/Model，机械门禁扫描
完整 `backend/src`，不允许通过 type-only import 或转发 alias 绕过。

### Composition root

`src/entrypoint/server.main.ts` 负责建立进程级 `AbortSignal`、加载配置和版本元数据，然后调用
`buildApplication(...).run(...)`。`src/app/composition-root.ts` 是服务的显式 composition root，负责：

1. 连接 PostgreSQL、Redis、MinIO，运行健康检查、schema 校验和默认数据初始化。
2. 创建 Identity、Storage、Agent、Task、System Module；Module 内的 `*.module.ts` 明确完成 Port 到默认实现
   的第一层绑定，LLM、Tool Registry 位于 `platform/` 并在启动期封闭。
3. 按配置创建 slog 或 OTLP/HTTP 观测 Provider，将 Runtime decorator、Provider shutdown 等依赖显式
   注入消费者；启动完成后不再改变 Registry 或能力图。
4. 收集各 Module 的路由依赖表并注册 Fastify 路由；Trace hook 在 HTTP 边缘处理 W3C Trace Context。
5. 启动 HTTP、Scheduler 和周期 delivery reconcile；收到信号或 serve 错误后取消并等待后台任务。
6. 先完成 HTTP draining/优雅停机并等待在途工作，再按 Redis、PostgreSQL 的逆创建顺序关闭其余资源。

应用 lifecycle 在资源创建后立即登记 close function，因此后续构建失败也会清理已建立连接；关闭至多
执行一次并聚合所有错误。这是静态、显式的依赖组装，不提供运行期服务查找，也不把应用容器传入业务模块。

全局 composition root 是跨 Module 第二层接线的唯一事实来源，各 `*.module.ts` 是 Module 内第一层实现
选择的唯一事实来源。Controller 和 Application Service 持有 Port 或内部 1:1 实现类：调用处不会重复 `new`
具体实现。人工审查时从依赖字段跳到 Port（或直接看实现类），搜索实现类的显式 `implements`（无 Port 的
1:1 实现类登记在 `backend/scripts/architecture-rules.mjs` 的 `NON_PORT_IMPLEMENTATION_CLASSES`），
再到对应 `*.module.ts` 查看 `new ConcreteClass(...)`；涉及跨 Module 依赖时继续回到
`src/app/composition-root.ts`。禁止仅依赖 TypeScript 结构化类型让一个类“碰巧”满足接口；Port 注释还应
指出默认实现和组装位置。接口只服务于真实的多实现/外部边界/跨模块共享，内部 1:1 业务 Service 不建 Port，
Controller 直接依赖实现类，保证完整流程能在单个公开方法内读完。

Identity Module 的注册与资料查询是内部 1:1 实现类（`application/{registration,profile}/service/`），
Controller 直接依赖；认证委托已并入共享真边界 `AuthServicePort`，不再有模块内窄 Port。
System Module 同样保持 Routes → Controller → Health Port → Service 的完整层次，Routes 不再内联探针
响应映射。
共享认证 PreHandler 将校验结果写成只读 `RequestPrincipal`；`*.routes.ts` 通过
`authenticatedPrincipal(request)` 读取 `userId` 并传入 Controller，Controller 不再解析 Bearer Token
或接触 HTTP 对象（logout/refresh 需要的 Bearer 提取同样归路由层）。

Agent 与 Task 存在双向业务协作，但不形成源码循环。全局组装顺序是：

```text
createAgentModuleCore
  → AgentModuleCore（公开窄能力；内部对象图由 complete 闭包持有）
  → createTaskModule
  → TaskResultDeliveryPort
  → createAgentModule
```

Agent Session 的展示消息字段转换是 `presentation/presenter/` 中的无状态纯函数；Task 复用公开字段映射，
并在自己的 Presenter 中完成 wire DTO 校验。跨 Module 不再传递 serializer 行为 Port。

Task 只通过 `AgentTaskCapabilities` 使用 `BackgroundAgentExecutionPort`、
`ExternalSessionTurnWriterPort` 和 `SessionLockRegistry`；Agent 普通对话只接收 Task 提供的
`TaskResultDeliveryPort`。双方都只从对方的 `public-api.ts` 导入公开契约。

`createAgentModuleCore()` 的返回类型不会暴露 Repository、MessageBuffer、LockRegistry 具体实现、
Executor 或 Loader；`createAgentModule()` 仅触发闭包中的第二阶段组装。各 Module 的返回契约只暴露入站能力和
composition root 确实需要的窄 Port。Identity 不返回
`UserRepository`，Storage 以 `StorageHealthPort` 代替 `ObjectStorage`，Task 的预组装对象封装全部
Repository，仅提供产品工具创建与完整 Module 创建方法。

Storage 的 `ObjectInfo` 与 `ObjectDownload` 位于 `service/application/model`；内部 1:1 的
`StorageService` 直接依赖出站 `ObjectStorage` Port。下载流由 HTTP 调用方消费，MinIO Adapter 监听请求取消并在流
`end/close/error` 后解除监听，不把私有 ObjectStorage 类型泄露到公开声明。

普通聊天由 `ProductAgentRunService` 编排；定时任务由 `TaskExecutionService` 编排（聚合快照、执行、落库/重试/投递）；Sub-Agent 由
`RuntimeChildRunner` 编排。普通聊天和 Sub-Agent 直接依赖统一的 `AgentExecutionPort`；定时任务通过
`BackgroundAgentExecutionPort` 间接复用同一执行边界。三者都不直接构造 SDK `RuntimeContext`、
`AgentNode` 或 `PipelineBuilder`。

不启动 Runtime 但需要追加恢复消息的业务路径依赖 `RuntimeStateAppender`；其实现
`RuntimeStateCodec` 与 `RuntimeAgentExecutor` 一样位于执行 Adapter，并由 `agent.module.ts` 显式注入。

## 固定能力图与部署更新

一次完整的 Chat、Answer、Resume 或 Scheduler 运行使用启动时已注入的 Runtime、Tool Catalog、LLM
Registry 和观测依赖；不再存在 Generation acquire/release、动态 Provider 子进程或插件回滚。

LLM Registry 固定的是协议 Adapter 的实现。`DbMainAgentLoader` 在每次新运行开始时从数据库读取 Agent
选择的模型、端点、凭据和参数并创建 Adapter，因此更新这些配置会在下一次运行生效，而不会改变已经
开始的流式运行。新增协议实现、工具代码或 Runtime 版本时，必须改代码、验证并部署新的产品实例。

部署平台负责构建、健康检查、滚动替换和旧实例的进程级退出；应用通过 `/health`、`/readyz`、`/version`
以及优雅停机配合部署。当前产品不包含 Supervisor、双端口代理或运行时插件管理面。

## HTTP 与契约

```text
HTTP request
    ↓ RequestID + Trace middleware（http.request）
Controller
    ↓ 已注入的 Application Service Port
Application Service / 业务生命周期
    ↓ Repository Port 或 AgentExecutionPort
Adapter / Runtime SDK
    ↓
产品 response 或 SSE event
```

- HTTP 方法、路径、信封、错误码和 SSE wire 结构以 `../../../api-contract/src/` 的可执行共享契约为准；
  [`../../contracts/api.md`](../../contracts/api.md) 是人类可读说明。
- 共享 `api-contract/src/<module>/dto.ts` 只声明 wire 数据结构；共享 Schema 位于同域文件，后端输入解析与
  领域到 wire 的映射分别位于 Module 的 `controller/*-request-parser.ts` 和 `*-presenter.ts`。Controller 是
  与 Fastify 解耦的 HTTP 用例控制器（方法签名即入参与返回），负责 DTO 投影和 `AppError` 映射；
  `*.routes.ts` 完成请求解包与成功信封输出，领域 Service/SDK 不依赖 Fastify 或 HTTP DTO。
- 未捕获错误只向客户端返回安全文案，完整上下文进入服务端日志。
- Runtime Event 是中性事件；`src/modules/agent/chat/controller/chat-event-presenter.ts` 负责映射为 SSE payload 和本地化状态文案。
- 完整的逐接口审查顺序和功能矩阵见 [`../../../backend/src/README.md`](../../../backend/src/README.md)。
- Request ID、Run ID 与 Trace ID 相互独立；具体层级与字段见
  [`observability.md`](observability.md)。

## Agent 组装

`DbMainAgentLoader` 从数据库加载 Agent、LLM、工具和可委派 Agent 配置，返回产品
`AgentBuildConfig`：

```text
core_agents + llm_configs + api_credentials
        ↓ provider name + credentials
sealed LLM Provider Registry（当前为 OpenAI-compatible 插件）
        ↓ LLMAdapterFactory
sealed Tool Registry（Runtime builtin + 产品 builtin 插件）
        ↓ Tool Catalog
DbMainAgentLoader（同时接收 LLMAdapterFactory）
        ↓
LLMAdapter + RuntimeConfig + tool schemas/dispatcher + child tools
        ↓ Runtime observability decorator
        ↓ ProductAgentRunService
SessionLifecycle.load → AgentExecutionPort.execute → SessionLifecycle.save → DeliveryQueue drain
```

主会话运行当前为：

```text
AgentLoader.load
  → SessionLifecycle.load
  → 可选 preparation（当前用于子执行恢复）
  → AgentExecutionPort.execute
  → 捕获展示与子 Agent section
  → SessionLifecycle.save
  → DeliveryQueue drain（配置投递队列时）
```

`RuntimeAgentExecutor` 使用 Runtime 的消息回调，把增量消息交给 MessageBuffer 与展示 collector。详细行为见
[`../agent/pipeline.md`](../agent/pipeline.md)。

## 产品与 Runtime 的边界

| 能力                               | Runtime SDK                                       | 产品宿主                                                                              |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ReAct、模型流、工具分发、interrupt | 提供中性契约和默认实现                            | 配置并映射到产品交互                                                                  |
| 执行入口                           | `AgentRuntime.run/resume`                         | `AgentExecutionPort` 与显式 Adapter                                                   |
| Checkpoint                         | 定义结构、校验、序列化与恢复语义                  | 以业务 `StoredRuntimeState` 信封单份持久化，Adapter 转换 payload，管理 revision/fence |
| Session                            | 不提供产品 Session                                | 用户归属、标题、RuntimeState、DisplayMessages、仓储                                   |
| 多实例协调                         | 只传递 fence/失租接口                             | Redis lease、heartbeat、DB sequence、故障处理                                         |
| 事件                               | 中性 Event                                        | SSE wire、中文状态和前端展示                                                          |
| 工具                               | 中性 Tool/Dispatcher 与可选 builtin               | 封闭 Tool Registry、Provider 插件、权限、默认启用、产品仓储工具                       |
| 子 Agent                           | `ChildRunner` / DelegationTool                    | DB 执行记录、恢复、事件包装与展示                                                     |
| LLM Provider                       | `LLMAdapter` / `LLMAdapterFactory` 与默认 Adapter | 启动期封闭 Registry、静态 Provider、凭据和每次运行的模型选择                          |
| 插件与观测                         | 静态 Plugin、Tracer、LLM/Tool/ChildRunner wrapper | 启动期依赖组装、HTTP/Pipeline/Scheduler span、slog/OTLP Provider、W3C 传播            |
| 核心进程更新                       | 无                                                | 构建并部署新的产品实例；应用提供版本与探针并优雅退出                                  |

禁止把产品 presentation、Session、Redis key 或 PostgreSQL row model 移入 Runtime。产品不复制 Runtime
的 ReAct 行为；但 Session、恢复消息、展示 JSON 和跨 Module Port 必须使用业务自有模型，避免把 SDK DTO
变成数据库与模块契约。`RuntimeAgentExecutor` 的 mapper/codec 负责与 SDK Message、Event、Checkpoint
转换，工具与模型 Adapter 等执行依赖仍通过 SDK 公开接口复用。

产品提交通过 `runtime.lock` 锁定已验证的 Runtime commit。跨仓变更需要先完成 Runtime 提交，再更新
产品 lock 并在两仓验证。

Chat、定时任务和 Sub-Agent 通过统一的 `AgentRunIdentity` 传递运行、会话、用户与 Trace 身份；执行结果
使用按 `status` 区分的联合类型，使失败必须携带 error、暂停必须携带 interrupt。Task execution ID 到
Agent run ID 的转换由具名构造函数完成，避免在调用点把不同身份字段静默混用。

## 会话一致性

产品 Session 是整份 JSONB 聚合，写入采用 revision CAS。一次聊天运行的保护链为：

1. `SessionLifecycle.load` 获取 Redis session lease。
2. fenced lease 提供单调 token，Session repository 先推进 fence 高水位。
3. user/assistant/tool 消息实时追加到 Redis MessageBuffer。
4. 失租通知通过组合后的 `AbortSignal` 取消 `AgentExecutionPort`。
5. `SessionLifecycle.save` 拒绝已失租 owner，并以 revision + fence 保存。
6. 保存成功后清理 buffer，finally 释放 lease。

Redis lease 降低并发，revision/fencing 防止旧 owner 覆盖新状态；两者都不保证外部工具副作用
exactly-once。详细恢复边界见 [`../session/session-recovery.md`](../session/session-recovery.md)。

## 定时任务与投递

Scheduler 扫描到期任务并为每次执行获取任务 lease。执行使用
`TaskExecutionService`（聚合运行快照、Agent 执行、落库/重试/投递的单一服务），结果先写
`agent_task_executions`，再进入 per-session `queue → processing → ack` 投递链路。

进程生命周期轮询由入站 Adapter `ScheduledTaskWorker` 持有；它只按间隔调用 `TaskSchedulerPort`。
`ScheduledTaskScheduler` 只负责待执行扫描、并发上限、lease 和执行超时。Task PostgreSQL Adapter 显式
实现 Command、Query、Execution、列表投影和视图状态等窄 Port，Application Service 不依赖数据库实现。
`TaskExecutionService` 由 `task.module.ts` 构造并注入 Scheduler，Service 在运行期不隐式选择另一项业务
实现；内部 1:1 的 Runner/Lifecycle/Worker 已删除独立 Port。

Task 不再自行组装 Agent 配置或写产品 Session：

- `TaskExecutionService → BackgroundAgentExecutionPort`，由 Agent Module 完成 Loader、Runtime 执行、
  恢复消息缓存和统一展示投影。
- `DeliveryQueue → ExternalSessionTurnWriterPort`，由 Agent Module 在 Session lease 内完成 fencing、去重、
  待交互判断以及 Runtime/DisplayMessage 的一致追加。

投递在 session lease 内进行，并用 execution ID 去重与周期 reconcile 提供 at-least-once 语义。
会话处于待回答 QuestionCard 时延迟投递，避免在悬空 tool call 后插入其他消息。详见
[`../agent/scheduled-task.md`](../agent/scheduled-task.md)。

## 子 Agent

Runtime `DelegationTool` 只依赖中性的 `ChildRunner`。产品的 `RuntimeChildRunner` 负责：

- 创建或加载 `sub_agent_executions`。
- 通过统一 `AgentExecutionPort` 执行，并使用独立 MessageBuffer key。
- 将中性子事件包装为产品 `agent_event`。
- 保存结果、interrupt 与可恢复上下文。

父子运行通过 `ToolCallContext` 传递只读标识和 EventSink，不共享可变执行上下文。

Chat 用例返回 `ChatRunHandle`，显式公开 `events`、`completion` 与 `close()`。HTTP Adapter 拥有事件
iterator 和心跳，客户端提前断开时关闭句柄；后台 Session finalization 使用独立超时继续完成。
`RunEventQueue` 使用固定容量，慢消费者导致溢出时会取消生产者，避免无界内存增长。

## 基础设施边界

- `src/infra` 可以依赖基础设施 SDK，但不包含业务决策。
- 业务模型不依赖 `src/infra`。
- PostgreSQL row 和参数化 SQL 留在 repository 或 loader 内，不进入公开领域契约。
- Redis key、TTL 和连接生命周期由宿主管理；Runtime 不读取这些配置。
- migration 由 `src/entrypoint/migrate.main.ts` 或开发环境显式自动迁移执行；生产实例只校验 schema。

## 扩展检查

| 改动                                | 必须同步检查                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 新 HTTP/SSE 行为                    | API 契约、后端 contract、前端 contract                                                                   |
| 新业务模块                          | Module 内 port/service/adapter、`*.module.ts`、`public-api.ts`、全局 composition root、AGENTS 与设计文档 |
| 新产品工具或 Tool Provider          | 工具设计、Provider/Registry、默认授权和专项 Skill                                                        |
| Session/lease/fence                 | 会话恢复、生产就绪、并发测试                                                                             |
| Runtime 接口                        | Runtime contract/guide、`runtime.lock`、两仓门禁                                                         |
| LLM Provider                        | Provider Registry 测试、启动组装、技术栈与凭据边界                                                       |
| Trace 或日志                        | 可观测性设计、API/SSE 契约、生产就绪清单                                                                 |
| 启动期 Registry、模型切换或部署更新 | 架构设计、API 契约、生产就绪清单                                                                         |
| UI 投影字段                         | presentation core、API/SSE 契约、前端类型与 Design System                                                |

## 架构机械门禁

`backend/scripts/check-architecture.mjs` 是快速、只读的边界检查，覆盖：

1. Controller 不得直接依赖 Repository 或 Adapter，只依赖 Application Service Port。
2. 跨 Module import 必须经过目标模块 `public-api.ts`。
3. Module 组装使用的生产默认实现必须显式 `implements` 对应 Port。
4. `adapter/` 中导出的生产类必须显式 `implements` 对应 Port。
5. `public-api.ts` 不得通过公开 Model/Port 转发 Runtime SDK 类型。
6. 白名单外的生产源码不得直接导入 Runtime SDK。
7. 已退役的 `src/api|engine|cli` 与 `test/api|engine|cli` 目录不得恢复。
8. Module 依赖图不得形成循环。
9. Service、Adapter 和 Model 不得转发权威 Port 类型；`public-api.ts` 不得直接导出内部
   Repository、Adapter 或 serializer helper。
10. 生产文件和测试文件超过职责规模触发线时输出人工审查 warning，不单因行数阻断构建。
11. `platform/shared/infra` 不得绕过业务 `public-api.ts` 深导入 Module，业务 Module 不得反向依赖 `app`。
12. `public-api.ts` 经 `*.module.ts` 间接导出的返回契约也不得泄露 Repository、Adapter、serializer 或
    `ObjectStorage`；门禁会递归追踪别名和多层接口组成的类型图。

运行入口为 `make be-architecture-check`（或在仓库根运行
`pnpm --filter @red-bean-nian-gao/backend architecture:check`），并已接入
`verify-quick` 和 `backend-ts-verify`。规则回归用例位于 `backend/test/architecture/`。若迁移期确需例外，
只能精确登记源文件与目标文件，并在完成迁移后删除；不得把规则放宽为目录级豁免。

门禁的源码解析与符号解析集中在 `backend/scripts/architecture-syntax.mjs`：它是 backend 内唯一接触
TypeScript 编译器 API 的位置，把源码转成与编译器版本无关的中性结构（语句种类、声明种类与名字、
JSDoc、公开类型图引用名），并只对外提供两个语义查询——`implements` 类型名解析到具名 interface、
`new X()` 解析到类声明。规则本体不引用编译器节点类型与常量，因此 TypeScript 主版本升级
（含 TS 7 的 Go 原生编译器与 7.1 的新公开 API）只需替换该文件实现。

## Port 边界名单与判据

接口（Port）只服务于三种真实需求，命中任一即保留；三条都不命中（内部 1:1 空转）即删除：

| 判据 | 说明 | 全仓实例 |
| --- | --- | --- |
| **① 外部系统适配** | SDK / Redis / Postgres / MinIO 等出站边界，实现可被真实基础设施或测试替换 | `ObjectStorage`、`MessageBuffer`、`SessionRepository`/`FencedSessionRepository`、`SubExecutionRepository`、`UserRepository`、`PasswordHasher`、`AgentExecutionPort`（Runtime SDK 唯一入口） |
| **② 跨模块共享** | 经 `public-api.ts` 在模块间传递的能力，模块边界需要类型契约 | `AuthServicePort`、`TaskResultDeliveryPort`、`ExternalSessionTurnWriterPort`、`BackgroundAgentExecutionPort`、`HealthServicePort`、`StorageHealthPort` |
| **③ 测试或宿主需要替换** | 被测对象的依赖存在测试 fake 挂载点；宿主注入点 | `ChatUseCasePort`、`AgentRunServicePort`、`SessionRunServicePort`、`CancelRegistryPort`、`SessionLockRegistry`、`ChildExecutionLifecycle`、`SubAgentDisplayRegistryPort`、`TaskResultDeliveryPort`（task 的 `DeliveryQueue` 实现） |
| 装饰链/多实现 | 多个生产实现或装饰链（与 ①③ 常重叠） | `AgentLoader`（database + prepared + observability 装饰链）、`MessageBuffer`（Redis + Memory） |

**删除面（改造完成态）**：task 7 个空转接口、identity 3 个 application Port、`SessionQueryServicePort`、
`SubAgentToolFactoryPort` 已删除；对应实现类直接承担消费方依赖并登记 `NON_PORT_IMPLEMENTATION_CLASSES`
白名单。新增能力按上表判定：命中 ①②③ 建
Port 并写 JSDoc 默认实现；未命中直接依赖实现类。

## 非目标

- 在 Controller 中直接实现业务持久化或 Runtime 循环。
- 在领域契约中引入 Fastify、`pg`、Redis、MinIO 等具体实现。
- 把产品展示模型重新放回 Runtime。
- 只依赖 Redis mutex 宣称 exactly-once。
- 在业务生命周期中直接构造 SDK `RuntimeContext`、`AgentNode` 或 `PipelineBuilder`。
