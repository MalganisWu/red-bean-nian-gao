# 工具系统设计

## 概述

工具系统负责工具的显式组装、查找和分发。主 Agent 的工具分三类：SDK 可选内置工具、宿主产品工具，
以及按 Agent 配置动态构建的委派工具。前两类通过启动期静态 Provider 插件进入封闭 Registry，
Agent Loader 只依赖只读 Catalog；系统工具与委派工具最终由 composite dispatcher 统一分发。

---

## 架构

```
Runtime Builtin Provider Plugin
    ├── sys_get_time / sys_http_request / sys_fetch_url（默认目录）
    └── 宿主显式选择的工具（createHostTools）
        sys_read_file / sys_list_directory / sys_glob / sys_grep
        sys_write_file / sys_edit_file / sys_apply_patch / sys_todo_write
        sys_shell
Product Builtin Provider Plugin
    └── sys_ask_user / sys_scheduled_task_manage
                ↓ 启动期注册
封闭 Tool Registry（实现只读 Catalog）

DbMainAgentLoader.load()
    ├── 从 DB 读取 sys_tool_ids → GetSchemas() / BuildDispatcher()
    └── 从 DB 读取 available_agent_ids → 构建 DelegationTool[]

CompositeDispatcher
    ├── sys dispatcher（系统工具）
    └── delegation dispatcher（委派工具）
        └── MapDispatcher{agentName → DelegationTool}
```

分发时先查系统工具，**仅当工具未注册（`ErrToolNotFound`）才回退到委派**；已注册工具的真实执行错误原样向上抛，不被掩盖。

---

## 静态插件注册

SDK 内置工具由 `red-bean-qing-tuan/tools` 的 `lookupBuiltinTool` 提供；需要产品仓储的工具由产品 Provider
插件构造。composition root 只负责选择并组合插件、显式注入依赖：

```ts
const toolRegistry = new ToolRegistry([
  runtimeBuiltinProvider(createHostTools()),
  productBuiltinProvider(taskRepository, idGenerator, timezone),
])
```

Registry 会拒绝 nil 工具、空白名称、工具名与 schema function name 不一致，以及任何重复注册；插件
名称也必须非空且唯一。构建完成后 Registrar 被封闭，运行期不能增删工具。文件类工具由宿主显式传入，
便于生产环境替换为 rooted、OSS 或数据库实现，不能隐藏在默认插件中；产品侧唯一的选择点是
`backend/src/platform/tool/provider/host-tools.ts` 的 `createHostTools`。

`createHostTools` 同时负责一件不能分散的事：读取工具与写入工具必须共用**同一个** `FileReadLedger`。
写入类工具依赖账本判断「当前会话是否读过该文件、读到的是哪个版本」，而读写是各自独立的实例；
每个工具自建账本会让「先读后写」闸门永远读不到读取记录，从而静默失去保护。

---

## 添加新系统工具

1. 通用工具放在 Runtime `src/tool/builtin/`，产品工具放在产品 `backend/src/modules/*/tool/`，实现
   Runtime 导出的 `Tool` 接口：

```ts
class MyTool implements Tool {
  public readonly name = 'my_tool'
  public readonly schema: ToolSchema = {
    type: 'function',
    function: {
      name: this.name,
      description: '工具描述',
      parameters: { type: 'object', properties: {} },
    },
  }

  public async execute(
    params: JsonValue,
    context: ToolCallContext,
    signal: AbortSignal
  ): Promise<ToolResult> {
    return { content: 'result' }
  }
}
```

2. 在对应 `ToolProviderPlugin.register` 中调用 `registrar.provide`。需要 repository 或外部服务的
   依赖由插件 factory 接收，并在 `backend/src/app/composition-root.ts` 显式传入。
3. 只有确实需要默认授权时，才把工具名加入 `backend/src/app/bootstrap.ts` 的
   `DEFAULT_AGENT_TOOL_IDS`；新增工具默认不自动获得权限。

需要 repository / 外部服务的工具必须走 factory 注入；注册发生在依赖创建之后、服务启动之前。
配置引用不存在的系统工具不会进入 schema 或 system dispatcher；若同名委派也不存在，调用会返回稳定的
`tool_not_found` 错误。

> `Description` 不是占位符：adapter 把工具定义**原样透传**给 LLM，`function.description` 是模型决定「是否调用」的信号，须写全「做什么 / 何时用 / 返回什么 / 何时不用（与相似工具的区分）」。制作系统工具的专项工作流见 Skill [`make-agent-system-tools`](../../../skills/make-agent-system-tools/SKILL.md)。

---

## 现有系统工具

| 工具 | 说明 | 状态 |
|------|------|------|
| `sys_http_request` | 通用 HTTP 请求（任意 method/header/body，原始响应体） | SDK 可选；默认 Agent 不授权 |
| `sys_get_time` | 获取当前系统时间，支持格式与时区 | 已注册，default agent 默认启用 |
| `sys_fetch_url` | 抓取网页并提取可读文本；默认只允许公网目的地 | SDK 可选；默认 Agent 不授权 |
| `sys_read_file` | 文件读取；生产应使用 rooted 版本 | 已注册；default agent 不授权 |
| `sys_list_directory` | 列出目录直接子项，目录以 `/` 结尾，结果排序并封顶 | 已注册；default agent 不授权 |
| `sys_glob` | 按 glob 模式发现文件，默认排除 `node_modules` 与 `.git` | 已注册；default agent 不授权 |
| `sys_grep` | 按正则检索文件内容，返回 `路径:行号:内容`；跳过的二进制与超大文件会明确计数 | 已注册；default agent 不授权 |
| `sys_write_file` | 新建或整体覆盖文件，同目录临时文件加原子重命名 | 已注册；default agent 不授权 |
| `sys_edit_file` | 精确串替换（可 `replace_all`），要求同一会话先读过且版本未变 | 已注册；default agent 不授权 |
| `sys_apply_patch` | 一次调用对同一文件施加多处改动，全部成功才写入 | 已注册；default agent 不授权 |
| `sys_todo_write` | 长任务待办清单，按会话隔离保存在进程内 | 已注册；default agent 不授权 |
| `sys_shell` | 执行 `bash -c`，返回分离的 stdout/stderr 与 `[exit code: N]`；超时或取消终止整个进程组 | 已注册，default agent 默认启用（见[决策](../../decisions/2026-09-17-default-agent-shell-authorization.md)） |
| `sys_scheduled_task_manage` | 定时任务管理（action 分发 create/update/delete/list/get），全部限定当前 session，局部更新、删除即终态 | 已注册（工厂注入），default agent 默认启用 |
| `sys_ask_user` | 向用户提问并通过结构化 `InterruptSignal` 挂起 | 已注册（工厂注入），default agent 默认启用 |

> **`sys_shell` 默认授权给默认助手**，因此日常对话即可执行任意命令。该授权**不**延伸到定时任务：定时任务的 `EXCLUDED_TASK_TOOL_NAMES` 排除 `sys_shell`，不留下无人值守的命令执行路径（见[决策](../../decisions/2026-10-08-scheduled-task-shell-exclusion.md)）。授权落在 `backend/src/app/bootstrap.ts` 的 `DEFAULT_AGENT_TOOL_IDS`，改数据库会被启动期的并集覆盖。

> **`sys_shell` 会削弱文件闸门**：它是任意命令执行，`sed -i`、`tee` 等都不经过 `FileReadLedger`，因此「先读后写」在它可用时只剩引导模型走正确路径的作用，不再是能强制执行的安全机制。它同时继承宿主进程环境变量（含部署凭据），且只支持前台执行——长命令会被超时终止，没有后台作业。给某个 Agent 开这个口子是需要单独判断的安全决策。

> **文件工具的共同前提**：这 8 个文件工具都不限制路径，只在部署平台已提供文件系统沙箱时才是安全的。代价、边界与授权前提见 [`docs/decisions/2026-09-17-unrestricted-agent-file-read.md`](../../decisions/2026-09-17-unrestricted-agent-file-read.md)。

> **定位区分**：`sys_http_request` 是 API 客户端，`sys_fetch_url` 用于提取网页正文。两者都通过安全 HTTP client 在解析、建连及重定向阶段拒绝私网、回环、链路本地和 CGNAT；只有宿主已有等价网络沙箱时才能显式使用 allow-all 策略。

---

## ToolDispatcher 接口

```ts
interface ToolDispatcher {
  dispatch(call: ToolCall, context: ToolCallContext, signal: AbortSignal): Promise<ToolResult>
}
```

当前编排使用两种实现：

| 实现 | 用途 |
|------|------|
| SDK `MapDispatcher` | 从 map 查找并执行工具 |
| 产品 `CompositeDispatcher` | 组合 sys + delegation，先查 sys，再仅在 `tool_not_found` 时回退 |

产品 `DbMainAgentLoader` 依赖最小的 Registry 查询面，不构造具体工具。数据库 `sys_tool_ids` 只选择
已注册工具；不存在的 ID 不会进入 schemas/dispatcher，已注册工具的真实执行错误不会触发委派回退。

---

## Context 传递

工具执行时，Runtime 在 dispatch 前注入只读的 `ToolCallContext`：

`execute` 的 `ToolCallContext` 参数提供 `threadId`、`userId`、`requestId`、`callId`、`traceId`、
checkpoint revision、fencing token 与可选 event sink。工具只能读取这些中性信息，不能取得或修改父
Pipeline Context；取消通过独立的 `AbortSignal` 传入。
