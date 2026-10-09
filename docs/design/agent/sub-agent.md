# 子 Agent 委派

> 文档性质：活文档。描述 Runtime DelegationTool 与产品 ChildRunner、执行记录和展示边界。

## 流程

```text
主 Agent tool call
  → Runtime DelegationTool
  → RuntimeChildRunner
  → SubExecutionLifecycle.load
  → AgentExecutionPort.execute
  → SubExecutionLifecycle.save
  → ChildRunResult 返回父 Agent
```

Runtime 工具只依赖中性的 `ChildRunner`。产品 `RuntimeChildRunner` 负责身份转换、事件包装和调用统一执行
Port；`SubExecutionLifecycle` 负责 PostgreSQL、MessageBuffer、展示和恢复。两者都不构造或持有 SDK
`RuntimeContext`。

## 调用身份

每个可委派 Agent 对应一个工具。新任务使用 `instruction`、可选 `context` 与 `expected_format`；恢复使用
已有 `execution_id` 和 `ChildResume`。Runtime 在 dispatch 前提供 thread/user/request/trace/call 等只读
身份，产品转换为 `ChildExecutionIdentity`。`callId` 同时作为 `parent_call_id`，用于把子过程挂回父工具。

新执行生成 `SAEX_*`。ExecutionID 同时是 `sub_agent_executions.execution_id` 与独立 MessageBuffer key。

## 恢复和持久化

- 新执行先创建 pending 业务记录。
- 恢复时同时校验 execution 的 session、user 和 agent 归属。
- 数据库只保存一个 `runtimeState`；其 payload 是 SDK checkpoint，不再保存重复 `llmContext`。
- 上次进程留下的 buffer 作为恢复增量交给 Runtime Adapter 去重合并，保存成功后才清理。
- `awaiting_user` 保存 interrupt checkpoint；恢复输入必须匹配当前唯一 interrupt ID。
- token、耗时、状态、结果摘要、错误和展示 sections 属于 SubExecution 业务记录。

## 事件与展示

子运行的中性 RuntimeEvent 被包装为 `agent_event`，包含 agent/execution/parent-call 身份。前端与持久化
展示均以 `parent_call_id` 将子过程嵌入对应父工具 section；不得依赖工具名、Agent 名或事件相邻顺序。

最终子 Agent sections 会写入 SubExecution，并由主会话展示 registry 嵌入父 DisplayMessage。Runtime
checkpoint 负责续跑，DisplayMessages 负责 UI，二者不能互相替代。

## 配置与安全

`DbMainAgentLoader` 为每个允许委派的目标加载模型、system prompt、工具和 RuntimeConfig，再把定义交给
`SubAgentToolFactoryPort`。`agent.module.ts` 将它绑定到 `RuntimeSubAgentToolFactory`；该 Runtime Adapter
显式构造 `RuntimeChildRunner` 与每次委派专属的 `SubExecutionLifecycle`。观测 decorator 分别包装子 LLM、
工具和 ChildRunner，使子 span 保持在父 `tool.execute` 下。

取消、exhausted、LLM 错误和持久化错误必须形成非 completed 结果。外部工具副作用仍需以执行身份实现
幂等或 outbox；ExecutionID 本身不提供 exactly-once。
