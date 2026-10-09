# 定时任务

> 文档性质：活文档。描述 Scheduler、统一 Agent 执行、执行记录和结果投递。

## 流程

```text
Scheduler 扫描到期任务
  → 并发额度 + task lease + execution timeout
  → scheduler.run span（独立 TraceID）
  → TaskExecutionService.run
  → AgentExecutionPort.execute
  → 落库/重试/投递（同一服务内）
  → execution record → per-session delivery queue
```

`TaskExecutionService` 使用业务 `ScheduledTaskRunState`，不创建 SDK `RuntimeContext`。它与普通聊天、
Sub-Agent 共享 Composition Root 中同一个 `RuntimeAgentExecutor`。

## 任务输入与运行

- 加载 Task 并校验 UserID/SessionID 归属。
- 生成 `TAEX_*` 作为 ExecutionID/RequestID。
- 将 TaskInput 作为 user 消息注入，按 Unicode code point 限制长度。
- 使用 `SectionCollector` 收集与普通聊天相同的 reason/tool/content 展示结构。
- 过滤 `sys_ask_user`、`sys_scheduled_task_manage` 与 `sys_shell`：无人可问、避免递归修改任务，且不继承
  默认助手的命令执行授权（见 [`../tool/tool-system.md`](../tool/tool-system.md)）。
- 任务 lease 由 Scheduler 持有；失租通知与 execution timeout 合并为执行 `AbortSignal`。

## 状态与执行记录

`AgentTaskDefinition` 保存任务配置。`AgentTaskExecution` 只保存已经发生的执行事实：身份、时间、状态、
DisplayMessages、结果/错误和投递状态，不保存任务配置，也不保存第二份 `llmContext`。

定时任务每次尝试从任务输入干净启动；MessageBuffer 只用于进程中断保护，尝试结束后清理。终态长期保留
展示、结果和完整工具 section，不需要把可恢复 checkpoint 复制进 execution 记录。

## 重试与落库

- 执行错误和非 completed Runtime 状态进入统一重试预算。
- 未达上限：只更新 RetryCount 与下一重试时间，不写终态 execution。
- 最终失败：事务内写 failed execution；一次性任务停用，周期任务重置预算并计算下个 Cron 时间。
- 成功：事务内写 completed execution；一次性任务停用，周期任务计算下一 Cron 时间。
- 成功或最终失败落库后进入投递队列。

## 结果投递

投递采用 Redis per-session `queue → processing → ack`，并以 execution ID 做持久化去重。投递过程获取
session lease，Session revision/fence 拒绝陈旧写入；待回答 QuestionCard 存在时延迟投递。

当前语义是 at-least-once 加业务去重，不承诺外部工具副作用 exactly-once。启动及周期 reconcile 会将
`delivered=false` 的记录重新入队。

## 展示约束

成功 execution 保存最终 DisplayMessages；最终失败生成单条可读消息，并保留最后一次尝试的 reason/tool
sections，不保留可能误导用户的半截 final content。前端使用与普通对话相同的 MessageCard、Process 和
Markdown 组件渲染。
