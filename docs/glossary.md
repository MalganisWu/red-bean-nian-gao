# 产品术语表

> 这份表是**给人读代码用的索引**，不是第二个事实来源。它只写三样：一句话定义、「**不是**……
> 的边界」、以及出处链接；推导与实现细节留在 [`design/`](design/)、[`contracts/`](contracts/)
> 与源码里。判断一个词该不该收：**不是"重要"，而是"读者会以为自己已经懂了"。**
>
> Runtime 仓 `red-bean-qing-tuan` 有它自己的一份 `docs/glossary.md`，收契约侧的词。
> **两份都不复制对方的定义**——遇到 Runtime 的契约词，这里只留一行说明它归谁。
> （跨仓不写 Markdown 链接：本机解析得到，但发布出去会 404。）

## 运行、执行与会话

- **run（运行）** — 会话里的一次运行，是运行事实与轨迹的归属单位。
  <a id="run"></a>

- **execution（执行）** — agent 执行器的一次调用；子 Agent 的每一次委派也是一次 execution。
  **不是** run 的同义词——run 是会话维度的，execution 是执行维度的，**顶层两者指同一次运行，
  子层只有 execution**。 <a id="execution"></a>

- **`runId` ≡ `executionId`** — 同一个实体的两个名字：子 Agent 的 `runId` 直接取它的
  `executionId`（`modules/agent/subagent/adapter/runtime-delegation-runner.ts`）。
  历史原因保留，**新增代码不要照此再起第三个名字**。 <a id="run-id"></a>

- **session ≙ Runtime 的 thread** — 产品在业务层说 `session`，Runtime 在协议层说 `thread`，
  两者在 Runtime Adapter 边界映射。**这不是用词不一致，是分层**——不要把两层统一成一个词。
  <a id="session"></a>

- **execution view state（执行视图状态）** — 前端对某次执行的阅读状态（已读、已展开等），
  只服务展示，**不是**执行本身的业务状态。见 `task_run_view_states` 表。 <a id="view-state"></a>

## 事实、轨迹与压缩

- **run fact（运行事实）** — 会话过程里按消息级追加的**只读审计记录**，是轨迹投影的数据源。
  **不是**事件（event）：事件是运行期的瞬时通知，事实是落库后不可改的历史。 <a id="run-fact"></a>

- **trajectory（轨迹）** — 由运行事实**投影**出来的只读审计视图。
  **不是**日志，**不是**通用意义上的"轨迹"：它是特定投影口径的产物，投影规则变了视图就变。
  <a id="trajectory"></a>

- **compaction** — 本仓 wire 契约里对**上下文压缩事实**的命名（SSE 事件类型与
  `TrajectoryCompactionDto`）。Runtime 侧把同一件事的模块叫 `compression`。
  两边指同一件事，**不是两个机制**；wire 上的名字已是既有契约，不改。 <a id="compaction"></a>

## 宿主责任

以下四个词产品与 Runtime **两边都写，但责任相反**：Runtime 只定义协议，产品才实现。

- **lease（租约）** — 产品给某个执行者发放的、带时限的写权限凭证。
  Runtime 明写「产品取消、锁与 ID registry 属于宿主，SDK 不提供」。 <a id="lease"></a>

- **fencing token** — 租约携带的单调令牌，用于让过期持有者的写入失效。
  **不是**鉴权凭证。 <a id="fencing-token"></a>

- **CAS** — 写入带 revision 的状态（会话、运行记录）时的 compare-and-swap。
  Runtime 只定义协议，存储层的拒绝由本仓实现。 <a id="cas"></a>

- **幂等键 / 重放（replay）** — 幂等键约束「同一个请求重复到达只产生一次副作用」；
  重放是「对已结束的恢复请求再次提交，按已记录结果应答而不是重新执行」。
  两者都**不是**重试——重试是请求没成功。 <a id="idempotency"></a>

## 交付与交互

- **投递（delivery）** — 定时任务产生的结果向目标会话**送达**的动作，含失败重试与终态记录。
  **不是**消息推送通知：它投递的是任务产出，走的是正常的结果落库路径。 <a id="delivery"></a>

- **ask card（询问卡片）** — 运行挂起等待人工作答时，前端渲染的那张交互卡片。
  对应的 Runtime 概念是 `interrupt` 屏障。 <a id="ask-card"></a>

## 取消与收尾

- **取消（cancel）** — 运行被外部中止，表现为 `AbortSignal` 的 abort。
- **中止（abort）** — 信号被置为已中止，或单个工具被停止；与「取消」是**不同主体**。
- **close** — 资源释放（连接、句柄、监听器），`onClose` 一类生命周期钩子。
- **shutdown** — 进程/服务的退出流程（`shutdownTasks`、`shutdownTimeoutMilliseconds`），
  内部会调用 `close`。四者是四件事，**不是同义词**。 <a id="cancel"></a>
