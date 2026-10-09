# 会话一致性与中断恢复

> 文档性质：活文档。描述产品 Session、RuntimeState、MessageBuffer、lease 与 CAS 的恢复边界。

## 状态职责

| 状态 | 存放位置 | 作用 |
| --- | --- | --- |
| 产品 Session | PostgreSQL | 用户归属、`runtimeState`、DisplayMessages、revision 与 fence |
| Runtime checkpoint | `runtimeState.payload` | SDK 定义的模型上下文、interrupt 与恢复状态 |
| MessageBuffer | Redis | 当前运行新增消息的临时 WAL |
| Session lease | Redis | 降低并发并提供失租通知与 fencing token |

Session 不再保存独立 `llmContext`。`StoredRuntimeState` 是业务信封，只包含 `engine`、`version` 和对业务
不透明的 `payload`；`RuntimeAgentExecutor` 校验信封版本与 checkpoint payload 版本一致。

## 正常路径

```text
SessionLifecycle.load
  acquire lease → advance fence → load Session revision/runtimeState
  → recover stale buffer（如有）→ append 本轮 user 到 buffer
        ↓
AgentExecutionPort.execute
  assistant/tool 经消息回调追加到 buffer
        ↓
SessionLifecycle.save
  verify lease → CAS/fenced Save(runtimeState + display) → Clear buffer → Release lease
```

Runtime checkpoint 和 DisplayMessages 在同一次 Session 保存中提交。Redis buffer 是临时 WAL，不是第二份
Runtime 状态；只有数据库提交成功后才清理。

## 进程内错误或取消

`RuntimeExecutionError` 携带包含 partial checkpoint 的结果。`ProductAgentRunService` 无论成功或失败都调用
`SessionLifecycle.save`：

1. 读取 buffer，不先删除。
2. `validateAndFix` 修复普通悬空 tool call；刻意挂起的 ask call 保留。
3. 将恢复消息交给 Runtime Adapter 与 checkpoint 去重合并。
4. 使用当前 revision/fence 保存新的 `runtimeState` 与展示投影。
5. 保存成功后清理 buffer，最后释放 lease。

进程在收尾前退出时，下一轮 `SessionLifecycle.load` 执行同一恢复流程。外部工具副作用不在 Session
事务内，必须另行实现幂等键或 outbox。

## lease 与 fencing

- `SessionLifecycle.load` 通过业务 lock registry 获取 lease，并由 repository 推进 fence 高水位。
- lease 的 `lost` Promise 与请求信号组合后传入 `AgentExecutionPort`，失租会取消 Runtime。
- 保存前再次检查失租；旧 owner 即使恢复运行也不能覆盖新状态。
- Redis lease 降低并发，revision/fencing 才是数据库防陈旧写入边界。

## MessageBuffer key

| 运行 | key | 用途 |
| --- | --- | --- |
| 主会话 | SessionID | 当前聊天轮增量 |
| 定时任务 | TaskID | 单次尝试增量，结束后丢弃 |
| Sub-Agent | ExecutionID（`SAEX_*`） | 每次委派独立恢复 |

## ask-card 恢复

- Runtime checkpoint 中的 interrupt 是恢复真相；DisplayMessages 中的 QuestionCard 是产品投影。
- answer 请求先校验待回答卡片和 interrupt ID，再通过 `AgentExecutionPort` 调用 `resume`。
- answer 失败时仍保存可恢复 checkpoint 与卡片状态，防止同一回答被无约束重复执行。
- pending 期间延迟普通聊天和定时任务投递，避免向悬空 tool call 中间插入消息。

## 不变量

- 数据库不得同时保存等价的 `runtimeState` 与 `llmContext`。
- 业务 Service 不读取 SDK checkpoint 内部字段；转换只在 Runtime Adapter/codec。
- RuntimeState、DisplayMessages 与完整工具执行事实用途不同，不互相替代。
