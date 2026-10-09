# API 契约（前后端共享公约）

> **机器唯一事实来源是 [`../../api-contract/src/`](../../api-contract/src/)。**
> 本文件是面向开发者的语义说明、示例和审查索引，不定义 TypeScript 类型。任何接口变更先改共享契约，
> 再同步生产者、消费者和本文。
>
> 配套机械校验（两侧各一，双向防漂移）：
> - **共享包** `make contract-verify`：检查 DTO、路由、错误码和运行时守卫可独立构建。
> - **TypeScript 后端** `make be-test`：实际注册路由和 SSE 序列化结果对照共享契约，并检查本文投影同步。
> - **前端** `make fe-contract`：服务调用、路径常量和 SSE 守卫对照共享契约，并检查本文投影同步。
>
> **共享契约、实现或本文任一侧漂移 → 对应契约测试失败**。

---

## 0. 使用指南（给 agent / 开发者）

按你的身份选择流程：

### 我改后端接口
1. 先读本文「1. 通用约定」理解语义，再读 `api-contract/src/` 确认可执行类型
2. 先改共享契约，再改后端实现
3. **同步更新本文**（路由总表 + 逐路由契约 + 错误码表）——不同步视为未完成
4. `make contract-verify && make be-test` 确认共享契约、实现和文档投影一致

### 我改前端消费
1. 消费任何接口前，先读本文对应路由的「逐路由契约」核对请求/响应形状与错误码
2. 前端直接消费 `@red-bean/api-contract`；仅展示态类型留在 `frontend/src/types/*`
3. 改完跑 `pnpm typecheck` 兜底

### 我新增/删除一个接口
1. 在 `api-contract/src/routes.ts` 增删路由，在对应业务域 `dto.ts` 和 `schema.ts` 中维护数据结构
2. 在本文「2. 路由总表」和「3. 逐路由契约」同步人类说明
3. 同步后端注册路由（`bindRoute`，method/path 取自 `API_ROUTES` 命名表）和前端服务调用（`API_ROUTES` + `buildPath`）
4. `make contract` 全绿

---

## 1. 通用约定

### 1.1 传输与全局中间件

- 所有 API 走 HTTP；`/api/agent/chat` 是 SSE 流式（`text/event-stream`），其余 JSON。
- HTTP 边缘（`backend/src/shared/http/fastify-http-boundary.ts`）统一处理 CORS、RequestID、Trace、ErrorHandler、
  JSON body limit 和 rate limit。
- **HTTP Request ID**：`RequestID` 中间件生成或复用上游 `X-Request-ID`，由响应同名 header 回传。
- **Trace ID**：`Trace` 中间件接受合法 W3C `traceparent` / `tracestate`，继承其中的 32 位十六进制
  Trace ID 和远端父 Span；header 缺失或非法时生成新 Trace ID。最终 ID 由 `X-Trace-ID` 响应头和
  SSE `start.trace_id` 回传，用于关联 HTTP、Pipeline、模型、工具与子 Agent。响应不回显
  `traceparent`；它只用于观测传播，不参与认证、授权、幂等或取消。
- **Run ID**：流式运行由服务端另行生成不可由客户端指定的 ID，在 `start.request_id` 回传；前端把它用于 `/api/agent/chat/cancel`。取消注册表按 `user_id + run_id` 隔离。

### 1.2 鉴权

- 方式：`Authorization: Bearer <JWT>`。`AuthMiddleware` 校验通过后把 `user_id` 写入 context。
- 路由总表中的「鉴权」列标注哪些需要；未标注的公开路由不需要 token。
- `/api/storage/*` 必须鉴权。对象 key 固定以 `uploads/<user_id>/` 开头；读取、删除和预签名操作会校验 key 归属，跨用户访问统一按资源不存在处理。

### 1.3 成功响应信封（统一为 A：全信封）

**所有业务 API 成功响应统一使用信封** `{code: 200, data: <payload>}`（HTTP 状态码保留语义，如注册为 201）：

```json
{ "code": 200, "data": { "token": "..." } }
```

- 纯通知类响应的 `message` 放在 `data` 内（如 `{"code":200,"data":{"message":"deleted"}}`）
- **例外**：`/health`、`/readyz` 是基础设施探针端点，保持裸返回（`{"status":"healthy|ready|not_ready"}`），不受本约定约束；`/api/storage/download/*` 返回文件字节流，同样不套信封

### 1.4 错误信封（✅ 已是统一规范）

所有错误响应统一为：

```json
{ "code": 4001, "message": "具体原因", "data": null }
```

- 由 Fastify 全局错误处理器与 `backend/src/shared/http/error-mapper.ts` 统一输出
- HTTP 状态码 = `AppError.httpStatus`，业务码 = `AppError.code`
- 前端解析：`frontend/src/lib/errors.ts` 的 `parseApiError` 提取 `{message, code}`，`services/api/client.ts` 在非 2xx 时抛出携带 `code` 的 `AppError`，供按业务码分流（i18n / 重试）

### 1.5 业务错误码表

| 业务码 | 含义 | HTTP | 后端构造器 | 典型场景 |
|--------|------|------|-----------|---------|
| 4001 | 参数校验失败 | 400 | `validationError` | 缺少必填字段、格式错误 |
| 4002 | 未授权 | 401 | `unauthorizedError` | 缺少/无效 token，用户名或密码错误 |
| 4003 | 无权限 | 403 | `forbiddenError` | 访问他人资源（任务归属校验） |
| 4004 | 资源不存在 | 404 | `notFoundError` | 会话/任务/用户不存在 |
| 4009 | 资源冲突 | 409 | `conflictError` | 用户名/邮箱已存在 |
| 5000 | 内部错误 | 500 | `internalError` / `loggedInternalError` | 未预捕获错误 |

> **安全消息策略**：已知错误（AppError）返回具体原因；未预捕获的裸错误一律返回固定文案 `"服务器内部错误"`，
> 完整错误信息由 `loggedInternalError` 写日志，**不泄露给客户端**。SSE `error` 事件遵守同一安全消息策略。

### 1.6 分页约定（sessions / tasks 列表）

- 游标分页：`?cursor=<updated_at ISO8601>&limit=<1-100>`
- 响应 `data.next_cursor` 为空字符串表示没有更多

---

## 2. 路由总表

> ⚠️ 本区表格是共享 `API_ROUTES` 的人类可读投影，契约测试会检查同步；**保持 4 列格式**，勿改列序/表头。

<!-- ROUTE-TABLE-START -->
| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | /health | 否 | 健康检查 |
| GET | /readyz | 否 | 就绪检查（含依赖状态） |
| GET | /version | 否 | 核心二进制构建版本探针 |
| POST | /api/register | 否 | 注册 |
| POST | /api/login | 否 | 登录 |
| POST | /api/logout | 否 | 登出 |
| POST | /api/refresh | 否 | 刷新 token |
| POST | /api/storage/upload | 是 | 文件上传（multipart） |
| GET | /api/storage/download/* | 是 | 下载文件 |
| DELETE | /api/storage/objects/* | 是 | 删除对象 |
| POST | /api/storage/presign/get | 是 | 生成临时下载 URL |
| POST | /api/storage/presign/put | 是 | 生成临时上传 URL |
| POST | /api/agent/chat | 是 | 流式对话（SSE） |
| POST | /api/agent/chat/cancel | 是 | 取消正在进行的流式请求 |
| POST | /api/agent/chat/answer | 是 | 提交询问卡片答案（SSE 续跑） |
| GET | /api/sessions | 是 | 会话列表（游标分页） |
| GET | /api/sessions/:id | 是 | 会话详情 |
| GET | /api/tasks | 是 | 任务列表（游标分页） |
| GET | /api/tasks/:id | 是 | 任务详情 |
| PUT | /api/tasks/:id | 是 | 更新任务 |
| DELETE | /api/tasks/:id | 是 | 删除任务（软删） |
| GET | /api/task-execution-view-states | 是 | 批量读取执行结果已读与折叠状态 |
| GET | /api/tasks/:id/executions | 是 | 任务执行记录列表 |
| GET | /api/tasks/:id/executions/:eid | 是 | 单条执行记录详情 |
| PUT | /api/tasks/:id/executions/:eid/view-state | 是 | 更新执行结果已读或折叠状态 |
| GET | /api/sessions/:id/tasks | 是 | 会话维度任务列表 |
| GET | /api/sessions/:id/trajectory | 是 | 会话轨迹（只读审计视图） |
| GET | /api/me | 是 | 当前用户信息 |
| PUT | /api/me | 是 | 更新当前用户 |
| GET | /api/users/:id | 是 | 指定用户信息 |
| GET | /api/users | 是 | 用户列表 |
<!-- ROUTE-TABLE-END -->

---

## 3. 逐路由契约

> 字段级定义以**权威类型**为准（后端与前端 TypeScript 类型及运行时 Schema），本文只列签名与要点，
> 不重复罗列字段（避免二次漂移）。

### 3.1 健康检查

**GET /health**
- 响应 `200`: `{"status":"healthy"}`
- 只表示进程能够响应 HTTP，不访问数据库、Redis 或对象存储，供 liveness probe 使用。
- > 探针端点，豁免成功信封（见「1.3」）

**GET /readyz**
- 响应 `200`: `{"status":"ready","checks":{"database":"ok","redis":"ok","storage":"ok"}}`
- 任一依赖失败 → `503`，`status` 为 `not_ready`，失败项值为 `error`；响应不泄露内部错误详情。
- 优雅停机排空期间 → `503` `{"status":"not_ready","checks":{"server":"draining"}}`。
- > 探针端点，豁免成功信封（见「1.3」）

**GET /version**
- 响应 `200`: `{"version":"v1.2.3","commit":"abc123","built_at":"2026-09-02T10:00:00Z"}`。
- 字段由 `APP_VERSION`、`GIT_COMMIT`、`BUILD_TIME` 注入；开发构建默认分别为
  `dev` / `unknown` / `unknown`。
- 部署平台可用此信息确认候选实例与本次发布记录一致；应用本身不提供升级或切流管理接口。
- > 探针端点，豁免成功信封（见「1.3」）

### 3.2 认证（user）

| 路由 | 请求 | 成功响应 | 错误 |
|------|------|---------|------|
| POST /api/register | `{username, email, password, display_name, avatar?}`（见 `RegisterRequest`） | `201` 信封 `data:{id, username, email, ...}` | 4001；4009 用户名/邮箱已存在 |
| POST /api/login | `{username, password}` | `200` 信封 `data:{token}` | 4001；4002 用户名或密码错误 |
| POST /api/logout | — | `200` 信封 `data:{message:"已退出登录"}` | 4001 缺少 token |
| POST /api/refresh | —（`Authorization` 头带旧 token） | `200` 信封 `data:{token}` | 4001；4002 token 无效 |
| GET /api/me | — | `200` 信封 `data:user` | 4002 |
| PUT /api/me | user 字段子集 | `200` 信封 `data:user` | 4002；4004 用户不存在 |
| GET /api/users/:id | — | `200` 信封 `data:user` | 4002；4004 用户不存在 |
| GET /api/users | `?offset=&limit=` | `200` 信封 `data:{users, total, offset, limit}` | 4002 |

用户响应按可见性分为两种显式投影：

- `SelfUser`（注册、`GET /api/me`、`PUT /api/me`）：`{id, username, display_name, avatar?, email}`。
- `PublicUser`（`GET /api/users/:id`、`GET /api/users` 列表项）：`{id, username, display_name, avatar?}`。

两者均不返回 `is_active`、`created_at`、`updated_at` 等内部账户字段。前端必须分别使用
`isUser`（本人）与 `isPublicUser`（公开资料）运行时守卫，不得用包含内部字段的持久化实体类型消费 API。

以下 golden 由后端路由测试与前端运行时守卫共同消费；任一侧改变用户响应形状时，契约测试必须同步失败：

<!-- USER-GOLDEN-START -->
```json
{
  "self_user": {
    "id": "user_1",
    "username": "alice",
    "email": "alice@example.com",
    "display_name": "Alice"
  },
  "public_user": {
    "id": "user_2",
    "username": "bob",
    "display_name": "Bob",
    "avatar": "https://x/a.png"
  },
  "user_list": {
    "users": [
      { "id": "user_1", "username": "alice", "display_name": "Alice" },
      {
        "id": "user_2",
        "username": "bob",
        "display_name": "Bob",
        "avatar": "https://x/a.png"
      }
    ],
    "total": 2,
    "offset": 0,
    "limit": 20
  }
}
```
<!-- USER-GOLDEN-END -->

前端常量：`frontend/src/lib/constants.ts` 的 `LOGIN/REGISTER/REFRESH/LOGOUT/ME/USERS`。后端路由：
`backend/src/modules/identity/controller/identity.routes.ts`。

### 3.3 流式对话（SSE）

**POST /api/agent/chat** — 一次消息生成 = 一条 SSE 连接，`done` 或 `error` 后关闭，不重连。

- 请求：`{messages: [{role: "user"|"assistant", content}], session_id?: string, agent_id?: string}`（见 `ChatRequest`）
  - 新会话（无 `session_id`）：`messages` 可提供初始化消息序列。
  - 已有会话（有 `session_id`）：历史由服务端加载，`messages` 表示当前轮且必须包含 user 消息；服务端只接受最后一条 user 消息，防止旧客户端重放历史。
- 响应：`200` `text/event-stream`，事件协议见「3.4 SSE 事件协议」
- 错误（连接建立前）：4001 参数校验；4002 未授权

**POST /api/agent/chat/cancel**
- 请求：`{request_id: string}`（取自 `start` 事件）
- 响应：`200` `{"code":200,"data":{"message":"取消信号已发送"}}`（**幂等**，request_id 不存在也返回 200；前端只校验信封，不读取该消息体）

**POST /api/agent/chat/answer** — 询问卡片（ask-card / human-in-loop）答案提交，复用同一条 pipeline 续跑，SSE 序列与 chat 一致。

- 请求：`{session_id, interaction_id, answers? | refused?}`（见 `AnswerRequest`）
  - `answers`: `{<question_id>: {kind: "option"|"multi"|"custom"|"skip", value?|values?}}`
  - `refused`: `true` 表示整卡拒绝（与 `answers` 二选一）
- 响应：`200` `text/event-stream`（StartEvent → 流 → DoneEvent，事件协议见「3.4」）；卡片在 `card` 事件 + DisplayMessages 中回显
- 错误：4001 参数校验；4009 交互不存在/已处理（幂等，已答卡片再答拒绝）；连接建立前的 4009 返回 JSON 信封

前端：`frontend/src/services/sse/fetch-sse.ts`（基于 `@microsoft/fetch-event-source`）。

### 3.4 SSE 事件协议

> Runtime 事件由 SDK `pipeline` 公开入口定义，产品传输映射位于
> `backend/src/modules/agent/chat/controller/chat-event-presenter.ts`；
> 前端类型位于 `frontend/src/types/events.ts`，三侧 wire JSON **必须一致**。
> 传输层说明见「3.5」。

| event | 前端类型守卫 | payload 字段 | 说明 |
|-------|------------|-------------|------|
| `start` | `isStartEvent` | `request_id`, `session_id`, `trace_id` | 连接建立，第一个事件；`request_id` 供 cancel，`trace_id` 供端到端排障 |
| `token` | `isTokenEvent` | `content` | LLM 流式回复文本 |
| `status` | `isStatusEvent` | `content`, `code?`, `attempt?`, `max_attempts?` | 本地化状态通知；次数字段仅重试状态使用 |
| `reason` | `isReasonEvent` | `content`, `step`, `timestamp` | 模型内部推理 |
| `tool_start` | `isToolStartEvent` | `tool_name`, `call_id`, `params` | 工具调用开始；无参数时 `params` 可为 `null` |
| `tool_result` | `isToolResultEvent` | `tool_name`, `call_id`, `content`, `error?` | 工具调用结果；`error` 非空 = 执行失败（此时 `content` 为 errJSON 喂 LLM，前端按 `error` 渲染 failed） |
| `card` | `isCardEvent` | `interaction_id`, `status`, `questions` | 询问卡片（ask-card 挂起时发出；卡片持久化走 DisplayMessages.Cards） |
| `done` | `isDoneEvent` | `tokens_used`, `session_id` | 正常结束 |
| `heartbeat` | `isHeartbeatEvent` | `timestamp` | Unix 毫秒时间戳；纯传输保活，前端忽略 |
| `error` | `isErrorEvent` | `code`, `message` | 错误通知，**见下方规范** |
| `compaction` | `isCompactionEvent` | `trigger`, `pre_tokens`, `post_tokens`, `messages_summarized` | Runtime 上下文压缩通知；当前前端校验后忽略 |
| `agent_event` | `isSubAgentEnvelope` | `agent_id`, `agent_name`, `execution_id`, `parent_call_id`, `event_type`, `event` | 子 Agent 委派事件信封；内层事件类型看 `event_type`，payload 与主 Agent 同构 |

> 全部 12 个正式事件类型均已有对应运行时守卫，表外无遗留兼容事件；推理统一使用 `reason`。
> `agent_event` 的信封由后端 pipeline 组装（db_loader 注入 subStream），
> 内层 `event` 是主 Agent 同构事件（token/reason/tool_start/tool_result/...），SSE event 行恒为 `agent_event`。

#### 3.4.1 Canonical payload golden

以下 JSON 由前后端契约测试共同读取。修改事件字段时必须同步更新类型、运行时守卫与本区；值只用于固定字段和 JSON 类型，不表达业务默认值。

<!-- SSE-GOLDEN-START -->
```json
{
  "start": {"request_id":"RUN_1","session_id":"SES_1","trace_id":"0123456789abcdef0123456789abcdef"},
  "token": {"content":"你"},
  "status": {"code":"llm_retry","attempt":2,"max_attempts":3,"content":"LLM 请求失败，正在进行第 1/2 次重试..."},
  "reason": {"content":"分析问题","step":1,"timestamp":1722751200000},
  "tool_start": {"tool_name":"get_weather","call_id":"call_1","params":{"city":"上海"}},
  "tool_result": {"tool_name":"get_weather","call_id":"call_1","content":"{}","error":"upstream timeout"},
  "card": {"interaction_id":"call_ask","status":"pending","questions":[{"id":"q1","text":"继续吗？","options":["继续","停止"],"select":"single"}]},
  "done": {"tokens_used":42,"session_id":"SES_1"},
  "heartbeat": {"timestamp":1722751200000},
  "error": {"code":5000,"message":"服务器内部错误"},
  "compaction": {"trigger":"auto","pre_tokens":10000,"post_tokens":3000,"messages_summarized":12},
  "agent_event": {"agent_id":"agent_child","agent_name":"研究员","execution_id":"exec_1","parent_call_id":"call_parent","event_type":"token","event":{"content":"结果"}}
}
```
<!-- SSE-GOLDEN-END -->

**error 事件规范（✅ 已落实）**：

- `code` 用「1.5 错误码表」的业务码（未预捕获为 `5000`）
- `message` 用安全文案：已捕获的 `AppError` 给具体原因，未预捕获给 `"服务器内部错误"`，完整错误由后端写日志，不泄露内部细节

### 3.5 传输无关性说明（SSE ↔ WebSocket 可换）

事件协议与传输层解耦：SSE 的 `event: <type>\ndata: <json>` 与 WebSocket 文本帧装载的是**同一个 JSON**。
若未来迁移 WebSocket，只改传输适配层与前端连接层，本文 3.4 的事件类型表原样保留。

### 3.6 会话（sessions）

| 路由 | 请求 | 成功响应 | 错误 |
|------|------|---------|------|
| GET /api/sessions | `?cursor=&limit=` | 信封 `{code:200, data:{sessions: [SessionSummary], next_cursor}}` | 4002 |
| GET /api/sessions/:id | — | 信封 `{code:200, data:SessionDetail}` | 4001；4004 会话不存在 |
| GET /api/sessions/:id/trajectory | — | 信封 `{code:200, data:SessionTrajectory}` | 4001；4004 会话不存在 |

- `SessionTrajectory`（`api-contract/src/trajectory/dto.ts`）：`{sessionId, title, turns[], compaction?,
  sessionEnd?, totalTokens, subAgentTokens, activeMs, spanMs}`。每个 turn 含
  `{turn, startedAt, durationMs, tokens, note?, records[], endState?}`；record 含
  `{id, seq, kind, at, summary, ...}`，kind ∈ `user|call|tool|subagent|turn-end|session-end`。
  **一次 LLM 调用只占一行**（`call`）：由一条 assistant 事实投影而来，`attempts[]` 是它的
  尝试明细（重试时多条，常态一条），字段 `{id, seq, model, attempt, durationMs, tokens, status, at}`。
  不设 `step`（投影期数出来的展示序号）与 `request`（已并入 `attempts`）——两者不是独立记录类型。
  审批工具（`ask_user` 等 interrupting 工具）在事实层是同一 `callId` 的两条 append-only 记录
  （挂起在 run N、闭合在 run N+1），投影按 `callId` 重建为**一行**；`waitMs` 为等待时长
  （`闭合.at − 挂起.at`），与 `durationMs`（工具执行时长）分开表达。
  数据源按会话二分：存在 `session_runs` 事实记录（G1）时，调用 `tokens`、`attempts`、轮次/会话
  合计与 `endState` 从事实日志投影；无 run 记录的旧会话回退 display_messages 投影，此时调用级
  `tokens`、`attempts` 为空（未采集）、`totalTokens` 为 null，前端显示占位不虚构。
  `endState.state` ∈ `completed|failed|cancelled|exhausted|interrupt|crashed`——**按触发者区分**：
  `interrupt` = **LLM 主动**发起（模型调用 interrupting 工具 → 挂起等作答，run 状态 `interrupted`
  的唯一来源）；`cancelled` = **用户主动**取消；`crashed` = **进程**崩溃遗留（run 仍为 `RUNNING`
  且早于本次进程启动）。三者不得混用，展示文案（「等待用户」「已取消」「已中断」）由前端映射。
  record 的 `status` ∈ `success|error|interrupt|incomplete`：`interrupt` 为等审批挂起，
  `incomplete` 为用户打断、没有结果；attempt 级 `status` 只有 `success|error`。
  `compaction`（G2）：会话存在压缩事实时返回最近一次压缩
  `{afterTurn, at, durationMs, beforeTokens, afterTokens, messages, status}`，
  status ∈ `success|failed|interrupted`（SDK 仅成功路径发事件，当前只落 success）；
  无压缩事实为 null。事实日志不可读（脏数据/未来版本）时整体回退 display_messages 投影而非报错。
  时间字段均为 epoch 毫秒。设计与缺口见 `docs/design/session/session-trajectory.md`。

- `SessionSummary`：`{id, title, message_count, updated_at}`（`backend/src/modules/agent/session/model/session.ts`）
- 会话详情与任务执行记录中的持久化 `DisplayMessage` 共用同一 wire shape：包含
  `role`、`timestamp` 及可选的 `content`、`sections`、`source`、`meta`，不包含前端运行时
  `id`。前端在进入列表渲染前生成稳定且唯一的 `id`，不得要求后端持久化该视图字段。
- `SessionDetail.messages[].content` 是可选字符串；使用结构化 `sections` 的助手消息可以不提供
  顶层 `content`，前端不得因此拒绝整个会话。
- 历史 `tool_group.tools[].duration` 是毫秒数值；前端加载后将其归一化为运行时
  `durationMs`。实时展示态遗留的字符串 `duration` 仍可兼容读取。
- `sections[type="reason"].items[]` 的持久化标准形态为
  `{itemType:"step", index, content}`；定时任务执行器必须与普通会话使用同一形态。
  前端 API 边界只接受这一形态；不符合契约的数据必须在存储层清洗。工具失败状态统一为
  `failed`，不得写入 `error`。
- 同一个推理 step 的连续流式片段必须在持久化前拼接为一个 reason item，不能把 token
  片段各自记录成独立步骤。
- 数据按 `user_id` 隔离（`backend/src/modules/agent/session/repository/adapter/postgres-session-repository.ts`
  的查询包含用户归属条件）
- 会话详情的 `DisplayMessage.sections[type="sub_agent"].items` 包含 `agent_id`、`agent_name`、
  `execution_id`、`parent_call_id`、`sections`、`status` 与可选 `result_summary`；前端以
  `parent_call_id` 精确恢复它与父工具调用的层级，缺失或无法匹配时保留独立委派步骤。

以下 golden 由后端路由测试与前端运行时守卫共同消费，特意覆盖省略顶层 `content` 的
结构化助手消息：

<!-- SESSION-DETAIL-GOLDEN-START -->
```json
{
  "id": "SESSION_1",
  "messages": [
    { "role": "user", "content": "你好", "timestamp": 1000 },
    {
      "role": "assistant",
      "sections": [
        {
          "type": "tool_group",
          "tools": [
            {
              "callId": "call_1",
              "name": "calc",
              "status": "success",
              "result": "42",
              "duration": 1234
            }
          ],
          "timestamp": 1500
        },
        { "type": "content", "content": "世界", "timestamp": 2000, "duration": 10 }
      ],
      "timestamp": 2000
    }
  ]
}
```
<!-- SESSION-DETAIL-GOLDEN-END -->

### 3.7 定时任务（tasks）

| 路由 | 请求 | 成功响应 | 错误 |
|------|------|---------|------|
| GET /api/tasks | `?cursor=&limit=` | 信封 `{code:200, data:{tasks:[TaskListItem], next_cursor}}` | 4002 |
| GET /api/tasks/:id | — | 信封 `{code:200, data:{task}}` | 4004；4003 无权访问 |
| PUT /api/tasks/:id | 任务字段子集（见 `AgentTaskDefinition`） | 信封 `{code:200, data:{message:"任务更新成功"}}` | 4001；4004；4003 |
| DELETE /api/tasks/:id | — | 信封 `{code:200, data:{message:"任务已删除"}}`（软删） | 4001；4003 |
| GET /api/task-execution-view-states | `?execution_ids=<id>,<id>`（去重后最多 100 个） | 信封 `{code:200, data:{view_states:[{execution_id, seen_at, collapsed_override, updated_at}]}}`；无持久化记录的可访问执行也返回，状态字段为 `null` | 4001；4002 |
| GET /api/tasks/:id/executions | `?cursor=&limit=` | 信封 `{code:200, data:{executions, next_cursor}}` | 4001 |
| GET /api/tasks/:id/executions/:eid | — | 信封 `{code:200, data:{execution}}` | 4001；4004；4003 |
| PUT /api/tasks/:id/executions/:eid/view-state | `{mark_seen?:true, collapsed_override?:boolean}`，至少一个有效动作 | 信封 `{code:200, data:{view_state}}` | 4001；4004；4003 |
| GET /api/sessions/:id/tasks | — | 信封 `{code:200, data:{tasks:[TaskListItem]}}` | 4001 |

`mark_seen:true` 只设置首次 `seen_at`，不会覆盖已有时间；未提供 `collapsed_override` 时保留原手动选择。批量读取和单次更新都按当前用户隔离，API 预加载本身不会标记已读。

`TaskListItem` 在 `AgentTaskDefinition` 的原有 PascalCase 字段外增加：

- `session_title?: string`：所属会话第一条用户消息的短标题；为空时省略。
- `latest_execution: TaskExecutionSummary | null`：该任务按 `created_at DESC, execution_id DESC`
  排序的最近一次执行；从未执行时为 `null`。
- `TaskExecutionSummary` 只含 `ExecutionID`、`Status`、`ScheduledAt`、`StartedAt`、
  `CompletedAt`、`ResultMessage`、`ErrorMessage`，不返回内部 `DisplayMessages` 或 RuntimeState
  或 `Delivered`；其中结果与错误文本最多返回前 256 个 Unicode 字符。

两个列表接口均由后端单次聚合查询生成以上字段；前端禁止逐任务调用执行记录接口。
分页游标为不透明字符串；新游标同时编码 `created_at` 与任务 ID 以保证同一时间创建的任务
不会跨页丢失，并兼容升级前的时间戳游标。

前端：`TASKS` / `SESSION_TASKS(sessionId)` / `TASK_EXECUTIONS(taskId)` / `TASK_EXECUTION(taskId, eid)` / `TASK_EXECUTION_VIEW_STATES(ids)` / `TASK_EXECUTION_VIEW_STATE(taskId, eid)`。

### 3.8 存储（storage）

| 路由 | 请求 | 成功响应 | 错误 |
|------|------|---------|------|
| POST /api/storage/upload | multipart，字段名 `file` | `200` 信封 `data:{key, size, content_type, etag}` | 4001 缺少文件/超过 20 MiB；4002 |
| GET /api/storage/download/* | — | 文件字节流（不套信封，见「1.3」） | 4002；4004 非本人对象 |
| DELETE /api/storage/objects/* | — | `200` 信封 `data:{message:"已删除"}` | 4002；4004 非本人对象 |
| POST /api/storage/presign/get | `{key, expires?}`（默认 900s，最大 3600s） | `200` 信封 `data:{url, expires_in}` | 4001；4002；4004 非本人对象 |
| POST /api/storage/presign/put | `{key, expires?}`（默认 900s，最大 3600s） | `200` 信封 `data:{url, expires_in}` | 4001；4002；4004 非本人对象 |

- Fastify 路由使用 wildcard `*` 捕获剩余 key，以便 key 中包含 `/`；前端统一从 `API_ROUTES.STORAGE_DOWNLOAD.path` 取基础路径并拼接完整 key，`STORAGE_OBJECTS` 同理。
- key 规则：`uploads/<userID>/<毫秒时间戳><扩展名>`。所有路由要求 Bearer JWT；读取、删除和预签名只接受当前用户前缀，跨用户 key 返回 4004，避免泄漏对象是否存在。
- 上传请求体最大 20 MiB；扩展名只保留最多 16 字符的 ASCII 字母或数字。

## 4. 已知不一致 / 待定决策（TODO）

> 本文诚实记录现状与规范之间的偏差。修一条删一条。当前无已知契约漂移。

---

## 5. 修订记录

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-07-31 | 初版 | 覆盖全部 26 条路由、错误码表、SSE 事件协议；记录 7 条已知不一致 |
| 2026-07-31 | 错误一致性修复 | 解决 #1 SSE error 安全消息、#2 成功信封统一 A（health/下载字节流为例外）、#3 NoRoute 兜底、#4 AppError 携带 code；已知不一致收敛为 3 条 |
| 2026-07-31 | 文案统一 + 守卫补齐 | 解决 #5（think/done/heartbeat 类型守卫；子 agent 层标注设计就绪）、#6（`"logged out successfully"`→`"已退出登录"`、`"task id"`→`"任务 ID"`、认证文案中文化）；已知不一致收敛为 1 条 |
| 2026-08-28 | 定时任务列表聚合 | 列表与会话任务接口返回 `TaskListItem`，批量携带会话标题与最近执行摘要，支持“需要关注”和未读状态展示 |
| 2026-08-31 | 安全与事件契约收口 | storage 全路由鉴权并校验 key 归属；修正 wildcard、health/readyz、status/heartbeat/compaction；新增前后端共享 SSE payload golden |
| 2026-09-03 | 能力图瘦身 | 删除动态插件与 Generation 管理 API；`/version` 保留为部署探针 |
| 2026-09-04 | TypeScript 后端切换 | 30 条路由与 SSE 契约由 Fastify 生产入口承担，Go 检查降为观察期 oracle |
| 2026-09-07 | Go 后端退役 | 删除 Go oracle，契约由 TypeScript 后端与前端双向测试持续校验 |
| 2026-10-08 | 存量兼容清理 | 删除不再有生产者的遗留结构：`DisplayMessage.think`/`ThinkEntry`/`serializeThinkEntry`、`PersistedDisplayMessageDto.steps`/`LegacyStepDto`/`isLegacyStep`、`PersistedMessageSectionDto` 的 `process` 变体/`ProcessStepItemDto`/`isProcessStep`、前端遗留 SSE `think` 事件；持久化形态以此文与 `api-contract` 为准 |
