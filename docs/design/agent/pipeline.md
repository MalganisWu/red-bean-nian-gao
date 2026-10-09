# Agent 执行编排

> 文档性质：活文档。描述产品业务生命周期如何通过统一 Port 使用 Runtime SDK。

## 统一执行边界

普通聊天、定时任务和 Sub-Agent 都依赖业务仓定义的 `AgentExecutionPort`：

```text
业务加载 → AgentExecutionPort.execute(command) → 业务保存
                         │
                         └─ RuntimeAgentExecutor → AgentRuntime.run/resume
```

`RuntimeAgentExecutor implements AgentExecutionPort` 负责 Command/Outcome 映射、checkpoint
解析与序列化、消息回调、事件转发和 Runtime 资源关闭。`RuntimeStateCodec implements
RuntimeStateAppender` 负责不启动 Runtime 时的恢复消息追加。它们共同构成 SDK Checkpoint 的业务防腐层，
并在 `agent.module.ts` 中通过明确的 `new` 绑定；Application Service 不直接导入这些 Adapter。

业务生命周期不得直接构造 SDK `RuntimeContext`、`AgentNode` 或 `PipelineBuilder`。SDK 的低层 Pipeline
仍是公开高级扩展能力，但不是本产品三类 Agent 的执行入口。

## 三类业务生命周期

### 普通聊天

```text
AgentLoader.load
  → SessionLifecycle.load（lease、状态恢复、answer 校验）
  → AgentExecutionPort.execute
  → SessionLifecycle.save（RuntimeState + DisplayMessages）
  → DeliveryQueue drain
```

`ProductAgentRunService` 转发 Runtime event 到 SSE，并用相同事件构建展示 section。消息回调把
assistant/tool 增量写入 MessageBuffer；最终以一份 `StoredRuntimeState` 提交。

### 定时任务

`TaskExecutionService`（聚合运行快照、Agent 执行、落库/重试/投递）加载 Task，过滤交互/递归任务工具后
调用同一执行 Port。任务的展示与结果投递由同一服务完成，由 `task.module.ts` 构造后注入 Scheduler。
任务 lease 由 Scheduler 持有，并通过组合 `AbortSignal` 取消执行。

### Sub-Agent

`RuntimeChildRunner` 从 SDK `ChildRunRequest` 创建业务 `ChildExecutionIdentity`，由
`SubExecutionLifecycle` 加载/保存唯一 RuntimeState。子事件按 `parent_call_id` 回传并嵌入父工具 section。

## 状态与展示

| 层                    | 所有者               | 用途                                     |
| --------------------- | -------------------- | ---------------------------------------- |
| Runtime checkpoint    | SDK 定义、业务持久化 | 模型续跑、interrupt 恢复、压缩后的上下文 |
| DisplayMessages       | 业务仓               | 稳定 UI 展示与卡片状态                   |
| execution/tool events | 业务仓               | 工具参数、结果、错误、耗时和追踪事实     |

Session 和 SubExecution 只保存一个 `StoredRuntimeState`，不得再复制一份 `llmContext`。定时任务终态
长期保存展示与结果；其运行消息只经临时 MessageBuffer 提供崩溃保护。

## 失败、恢复与并发

- MessageBuffer 是临时 WAL，不是第二份 Runtime 主状态；业务提交成功后清理。
- Session 保存使用 revision + fencing，失租后的旧 owner 不得提交。
- `RuntimeExecutionError.result` 仍包含可保存 checkpoint；业务生命周期应先保存结果再传播错误。
- 外部工具副作用不在 Session 事务内，仍需幂等键或 outbox。
- ask-card 恢复必须匹配当前 checkpoint 的唯一 interrupt ID。

## 扩展规则

- 新 Agent 运行类型优先复用 `AgentExecutionPort`，业务差异放在执行前后的生命周期服务。
- Runtime Command/Outcome 与产品 DTO 的转换只放在 `RuntimeAgentExecutor` 附近。
- 新展示逻辑消费中性消息/事件，不反向写 SDK checkpoint。
- 新状态字段先确认属于 Runtime、业务聚合还是 HTTP wire，禁止跨层共用 DTO。
