# 决策：字面量联合必须通过 const 成员引用使用（导航与防漂移）

状态：已接受
日期：2026-09-10

背景：`bindRoute(server, 'CHAT', ...)` 这类以字符串键传参的写法让 IDE 只能
"从使用点跳定义"（类型推断），无法"从定义找全部使用点"（Find Usages 为空）——
目录与注册点之间是导航单行道。同类断点还存在于 switch case 标签
（`case 'start'`）、`.kind === 'resume'` 比较等全部字面量联合使用点。

选项：
- 字符串字面量原样使用（现状）：类型安全仍成立，但导航单行道 + 拼写漂移无法被发现。
- 全部改为成员引用（选定）：比较、case 标签、构造统一写 `CONST.MEMBER`；
  字面量联合若无 const 源，先建立 const 映射（`Object.freeze({...} as const)`）。

决策：成员引用。`bindRoute` 改为接收 `API_ROUTES` 成员对象；新增
`STREAM_EVENT_TYPES`（agent-run）、`EXECUTION_COMMAND_KINDS` /
`EXECUTION_OUTCOME_STATUSES`（execution port）、`STREAM_STEP_KINDS`（chat-stream）
四个 const 源，替换全部字符串比较与 case 标签。

理由：const 成员是常量表达式，可直接作 case 标签且与接口里的字面量类型保持值一致；
约束成本仅一行 import。防漂移收益：拼写错误在类型检查时暴露（case 不匹配 → 穷尽性
检查或永不命中）。

后果：
- 接口/类型声明中的字面量类型保持原样（仓库既有模式，如 `AGENT_EVENT_TYPES` 与
  接口 `type: 'token'` 并存）；只约束"使用点"。
- 规则写入 typescript-coding-conventions 硬性禁止 + AGENTS.md 安全基线。
- 已知例外：SDK/外部协议的字符串（Checkpoint 状态、config 段名、环境变量、
  Redis key 前缀）属外部契约，不建自仓 const 源；同值不同域（如 Checkpoint 的
  'completed' 与宿主执行结果的 'completed'）各自引用各自 const 源，禁止混用。