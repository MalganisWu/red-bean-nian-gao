# Agent Module

负责普通对话、Session 生命周期、Runtime 执行适配和 Sub-Agent。推荐阅读顺序：

```text
http-api.ts
→ chat/controller/chat.routes.ts
→ chat/controller/chat.controller.ts
→ chat/port/chat-use-case.port.ts
→ chat/service/default-chat-service.ts
→ run/port/agent-run-service.port.ts
→ run/service/default-agent-run-service.ts
→ session/run/port/session-run-service.port.ts
→ session/run/service/default-session-run-service.ts
→ execution/port/agent-executor.ts
→ execution/adapter/runtime-agent-executor.ts
→ agent.module.ts
```

`agent.module.ts` 明确绑定 Module 内实现。产品 Session、展示消息和 Redis 恢复缓冲属于本模块，
不进入 Runtime SDK。业务 Port 使用 `model/agent-message.ts` 与 `model/json-value.ts`；
`execution/adapter/runtime-message-mapper.ts` 负责与 SDK 消息双向转换，Checkpoint payload 只由
`execution/adapter/runtime-state-codec.ts` 解释。需要追加恢复消息的业务 Service 只依赖
`RuntimeStateAppender`，具体 `RuntimeStateCodec` 在 `agent.module.ts` 中显式注入。
数据库 Loader 只负责读取 Agent、模型和工具定义；`PreparedAgentLoader` 在模块组装层附加
`SubExecutionRecovery`，因此 Loader 不持有子执行仓储或 Checkpoint 恢复依赖。

`DefaultChatService` 是 HTTP Controller 之后的聊天入站用例：它统一生成运行身份、
注册取消信号、跟踪活动 `ChatRunHandle` 并在停机时等待 finalization。`ChatController` 只负责
HTTP/SSE 输入输出，不直接持有 `AgentRunServicePort` 或取消 Registry。

Chat、后台任务和 Sub-Agent 都使用 `AgentRunIdentity` 传递 `runId/sessionId/userId/traceId`；父子关系与
重试次数通过可选字段显式表达。`AgentExecutionOutcome` 和公开的后台执行结果均为可辨识联合，调用方必须
按状态处理完成、暂停、取消、耗尽与失败，不能组合出“失败但无 error”等非法状态。

`presentation/model/display-message.ts` 是纯数据模型，不包含 serializer。Agent Session 的数据库与 HTTP
字段转换复用本模块 `presentation/presenter/` 的纯函数；Task 对自己持有的展示结果在 Task Presenter 内
校验 wire DTO。`public-api.ts` 只公开 `DisplayMessage` 数据模型和无状态字段映射，不公开 serializer Port、
Executor、Repository、MessageBuffer 或 Session 运行 Port。

Session 查询使用内部 1:1 实现类 `session/query/service/default-session-query-service.ts`（无独立 Port），
HTTP Controller 直接依赖该实现类，不直接访问 Session Repository。

## 面向 Task 的公开能力

Task Module 只从 `public-api.ts` 使用 Agent 的窄 Port，不接触 Agent 内部 Adapter：

```text
Task TaskExecutionService
→ BackgroundAgentExecutionPort
→ DefaultBackgroundAgentExecutionService
→ AgentLoader + AgentExecutionPort + MessageBuffer（均为 Agent Module 内部 Port）
→ Runtime SDK

Task DeliveryQueue
→ ExternalSessionTurnWriterPort
→ DefaultExternalSessionTurnWriter
→ SessionLockRegistry + FencedSessionRepository + RuntimeStateAppender

Task HTTP / PostgreSQL Adapter
→ Task 内部纯字段 Presenter
```

`BackgroundAgentExecutionPort` 负责隐藏 SDK 配置选择、工具过滤、恢复消息缓存和展示投影。
`ExternalSessionTurnWriterPort` 负责隐藏 Session lease、fencing、重复投递判断、待交互判断以及 Runtime
消息追加。因此 Task 只表达“执行后台 Agent”和“写入外部回合”，不会复制普通对话的底层机制。

反方向的依赖是 `ProductAgentRunService → TaskResultDeliveryPort`，用于普通对话开始前排空待投递结果。
具体实现由 Task Module 提供，但 Agent 源码不导入 Task 内部文件。

Chat Application Service 返回 `ChatRunHandle`，而不是裸 `AsyncIterable`。句柄明确区分事件消费、后台
完成和主动关闭；事件队列有容量上限，HTTP Adapter 在客户端断连或 iterator 提前结束时负责调用
`close()`，Session finalization 使用独立超时继续完成事实提交。

## 两阶段组装

为消除 Agent/Task 的源码循环，组装顺序固定为：

1. `createAgentModuleCore(...)` 创建 Agent 内部执行基础与 Session 展示序列化实现，返回窄
   `AgentModuleCore`；Task 只能读取
   `AgentTaskCapabilities` 与 Session 锁，第二阶段对象图由 `complete(...)` 闭包持有。
2. `createTaskModule({ agent: agentCore, ... })` 使用后台执行、外部回合写入和 Session 锁能力。
3. `createAgentModule(agentCore, tasks.deliveryQueue, ...)` 调用核心句柄的 `complete(...)`，接入
   `TaskResultDeliveryPort` 并完成聊天与 Session HTTP 用例组装；Repository、MessageBuffer、LockRegistry、
   Executor 与 Loader 不会进入 public-api 的声明类型图。

跨 Module 接线只出现在 `app/composition-root.ts`；Agent 内 `Port → 默认实现` 的选择只出现在
`agent.module.ts`。

对应测试按可观察能力归档：Chat/运行主链位于
`test/modules/agent/{chat,run,execution}/`，Session 与 Sub-Agent 位于
`test/modules/agent/{session,subagent}/`，Loader、取消、展示和观测分别位于同名能力目录。
Task 调用的后台执行与外部回合写入还会在 `test/modules/task/delivery/` 的跨 Module 场景中验证。

## 文件规模审查

本轮按职责自然拆分了运行编排辅助函数、展示消息收集与中断组装、子执行心跳与结果处理、
Session 行映射以及 Task 投递消息投影。`SessionLifecycle` 保留约 277 行：`load/save`
共同维护 lease、fencing、revision、buffer generation 和恢复提交不变量，属于同一个一致性状态机；
继续按行数拆分会让关键状态转换分散到多个对象，反而降低审查时的完整性。
