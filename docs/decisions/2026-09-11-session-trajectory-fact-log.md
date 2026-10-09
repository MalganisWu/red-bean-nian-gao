# 决策：会话轨迹的独立事实日志（display_messages 不动，run 容器 + 四类消息级事实）

状态：已接受
日期：2026-09-11

背景：会话轨迹视图（`docs/design/session/session-trajectory.md`）需要 token 用量、LLM 请求重试、
压缩事件、轮次终态等审计事实，而 `display_messages` 是为聊天渲染设计的有损投影（这些事实从未
采集或被抹平）；`runtime_state` 是 Runtime SDK 的不透明恢复 checkpoint，业务不可读。讨论中确认
三条边界：①展示投影与事实日志是两种东西，不共享 Schema/接口；②interrupt/审批只是挂起期长的
工具调用，日志不需要为它单设类型；③日志只有 user / assistant / tool / compaction 四种消息级
事实。

选项：
- A. 轨迹读 display_messages：零新持久化，但审计事实永远缺失（投影已丢弃），否决。
- B. 轨迹读 runtime_state：payload 不透明是架构红线，且格式耦合 SDK 版本，否决。
- C. display_messages 重构为日志投影：card 交互态等渲染结构不属于事实，合并会把 UI 词汇
  泄漏进日志；存量会话还要双读或回填，风险大收益小，否决。
- D. 新增独立事实日志：运行时事件流双写——展示走 display_messages（一字不动），事实走
  session_runs（append-only）。

决策：D。事实模型定稿为——

```text
session_runs（一个 run 一行，append-only）
  run 容器: runId, traceId, provider, model, contextWindow,
            startedAt, endedAt, status(completed/failed/cancelled/interrupted/exhausted),
            cancelledAt?, cancelledBy?(user/system), error?,
            header?(系统提示词+工具目录+调用配置快照，变更才记；首版记录不展示),
            schemaVersion
  facts[]:  user      { content, source?, at }
            assistant { at, durationMs, usage{prompt,completion,cacheRead}, attempts[],
                        thinking, content }
            tool      { callId, name, params, result|error, startedAt, durationMs }
会话级:    compaction { at, trigger, before/afterTokens, messages, durationMs,
                        status(success/failed/interrupted) }
```

理由：
- 用户主动取消是 run 的状态事实（cancelledAt/cancelledBy），不是第五种消息级类型；
  子 Agent 委派在父 run 里是一次 tool 事实，子执行的内部步骤进子执行自己的 run 记录。
- run 级 header 快照回答"模型当时到底看到了什么"，并带 request/header 去重纪律；
  provider/model/contextWindow 回答"数字异常是不是换了模型"。
- 版本纪律：每条记录带 schemaVersion；读取遇到未知类型时，标记 ignorable 的跳过、
  未标记的拒绝重放——事实日志长寿命，没有自描述必然静默误读。
- 远期若出现第三消费者或双写分叉成真，display_messages 的事实部分可改为从日志投影重建；
  日志建成超集正是为保留该选项，但今天不做。

后果：
- G1 新增 migration（session_runs 表）与运行时写入路径（run service 完成/终态时落 run 容器，
  事件流上同步 append facts）；display_messages 写入路径零改动。
- 轨迹 API 在 G0 先读 display_messages 出骨架，G1 后 token/请求/终态维度切到事实日志。
- 聊天渲染与轨迹审计各自演化互不影响；任一结构的修改都不会污染另一个。
