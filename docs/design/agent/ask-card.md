# 询问卡片与人工确认

> 文档性质：活文档。视觉以 Design System 的真实 `QuestionCard`、Showcase 和 Conversation Foundation
> 为准；本文只描述产品协议、状态和恢复边界。

## 定位

Agent 需要确认或补充信息时，通过中断型工具暂停运行，把结构化问题显示在当前 Process 中；用户回答
后从同一会话和同一 tool call 继续。等待期间不占用执行线程或 session lease。

## 两阶段流程

```text
ask:
LLM → sys_ask_user → ToolResult.Signal(InterruptSignal)
    → Runtime 停止同批其他工具并返回 awaiting_user
    → PresentationInterruptAssembler 生成 CardEvent + pending card section
    → SessionLifecycle.save 保存并释放 lease

answer:
POST /api/agent/chat/answer
    → SessionLifecycle.load 获取 lease、校验 pending card
    → 追加匹配 interaction_id 的 tool result
    → Runtime 继续 ReAct
    → SessionLifecycle.save 原地解决卡片并合并续跑 sections
```

`interaction_id` 等于原 tool call ID，同时用于卡片标识、answer 引用和恢复 tool result 的
`toolCallId`，不生成第二套 ID。

## 工具与 Runtime 边界

- `sys_ask_user` 校验问题、选项和选择方式；非法参数返回普通工具错误，不挂起。
- 合法调用返回结构化 `InterruptSignal`，不依赖内容字符串或工具名嗅探。
- Schema 的 `interrupting` 标志让 Runtime 抑制重复的工具开始/结果展示。
- 同一批工具出现 interrupt 时，其余工具不执行，避免确认前产生副作用。
- Runtime 只返回中性 `Interrupt`；`PresentationInterruptAssembler` 负责产品 CardEvent、DisplayMessage 和中文展示。

## 卡片持久化

卡片是 DisplayMessage 中的 `type="card"` section：

```json
{
  "type": "card",
  "card": {
    "interaction_id": "call_xxx",
    "status": "pending",
    "questions": [],
    "answers": null
  }
}
```

- pending 卡片表示交互未决；普通聊天返回冲突，answer 是唯一解算入口。
- answer 成功受理后原地改为 `answered` 或 `refused` 并写入答案。
- 已解决卡片不可再次提交；后端以冲突响应兜底重复点击和跨端请求。
- 卡片不单独建表，刷新时从 Session DisplayMessages 恢复。

## answer wire

选择回答：

```json
{
  "session_id": "SESS_xxx",
  "interaction_id": "call_xxx",
  "answers": {
    "q1": {"kind": "option", "value": "确认"},
    "q2": {"kind": "multi", "values": ["保留记录"]}
  }
}
```

整卡拒绝：

```json
{
  "session_id": "SESS_xxx",
  "interaction_id": "call_xxx",
  "refused": true
}
```

answer 类型支持 `option`、`multi`、`skip`；`custom` 保留兼容能力，但当前正式 tool/SSE question
没有开放自定义输入字段。完整 HTTP/SSE 契约见 [`../../contracts/api.md`](../../contracts/api.md)。

## 恢复不变量

- pending 期间禁止普通聊天。
- `DeliveryQueue.deliverOne` 遇到 pending 卡片延迟投递；round-end drain 也跳过 `awaiting_user`。
- 因此待回答的 ask tool call 必须位于 Runtime checkpoint messages 末尾；answer 采用“append + 断言”，不在历史中猜测插入位置。
- 恢复路径为普通悬空工具补错误结果，但对当前 interrupt call ID 保持悬空。
- answer 已进入 buffer 后即视为被消费。若续跑失败，卡片仍落为 answered/refused，避免再次执行同一回答。

外部工具副作用不由卡片状态回滚；中断前可能执行的工具仍需自身幂等或补偿。

## 前端状态

| 状态 | 行为 |
| --- | --- |
| `pending` | 卡片在当前 Process 中常显并可回答 |
| `submitting` | 保留选择，锁定重复提交，显示正在提交 |
| `accepted` | 收到 answer SSE start 后原地压缩为问题与回答，Process 继续运行 |
| `answered/refused` | done 后成为持久终态，刷新仍可见且不可重答 |
| start 前失败 | 回到 pending，保留草稿并允许重试 |
| start 后中断 | 保留已消费回答和已收到内容，标记本轮取消，不回滚 pending |

卡片属于一个 Process，不创建第二条消息或第二个折叠块。后续 narration、工具和再次确认都按时间顺序
插入同一 Process；`sys_ask_user` 自身不重复显示普通工具行。

## 视觉边界

- 正式组件是 `design-system/src/components/QuestionCard.tsx`，前端通过 alias 直接使用。
- 状态、间距、颜色和 Light/Dark 规则由 Design System token、Showcase 与 Foundation 决定。
- `allowCustomAnswer` 当前只用于展示/未来能力；正式 MessageCard 不启用。
- 多问题按一题一页；跳过与整卡拒绝是不同操作。

## 非目标

- 不设置自动过期；长期不答即保持挂起。
- 不在 Runtime 中引入 Web 卡片或产品文案。
- 不允许定时任务投递绕过 pending 守卫。
