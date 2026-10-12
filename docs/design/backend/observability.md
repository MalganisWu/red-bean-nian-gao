# 后端可观测性与链路身份

> 文档性质：活文档。描述当前请求、运行与 Trace 的身份边界，以及产品观测包装器的接线方式。

## 三类身份

| 身份 | 生成位置 | 生命周期 | 对外位置 | 用途 |
| --- | --- | --- | --- | --- |
| HTTP Request ID | `RequestID` middleware；可复用 `X-Request-ID` | 一次 HTTP 请求 | `X-Request-ID` | 网关与 HTTP 日志关联 |
| Run ID | `DefaultChatService.start` 生成（`RUN` 前缀） | 一次 chat/answer 执行 | SSE `start.request_id` | 取消注册与运行幂等关联 |
| Trace ID | 合法入站 `traceparent`、`Trace` middleware 或 Scheduler | 一条完整执行链 | `X-Trace-ID`、SSE `start.trace_id` | 跨 HTTP、Pipeline、模型、工具和子调用排障 |

三者不得复用。Trace ID 是 W3C 兼容的 32 位小写十六进制值。HTTP 边缘通过中性
`TraceContextExtractorPort` 接受合法 `traceparent` / `tracestate`；缺失或非法时生成新 Trace。
响应继续只返回便于客户端排障的 `X-Trace-ID`，不回显入站 `traceparent`。

## Trace 层级

普通请求：

```text
http.request
├── agent.load
└── agent.execute
    ├── llm.stream
    └── tool.execute
        └── agent.delegate
            ├── llm.stream
            └── tool.execute
```

定时任务：

```text
scheduler.run
├── agent.load
└── agent.execute
    ├── llm.stream
    └── tool.execute
```

上图 span 名以代码为准：`http.request`（`src/shared/http/fastify-http-boundary.ts`）、`agent.load`
（`src/modules/agent/observability/agent-observability.ts`）、`agent.execute`
（`src/modules/agent/execution/adapter/runtime-agent-executor.ts`）、`scheduler.run`
（`src/modules/task/service/scheduling/task-execution-service.ts`），以及 Runtime SDK 侧的
`llm.stream` / `tool.execute` / `agent.delegate`
（`red-bean-qing-tuan/src/runtime/observability/runtime-trace-plugin.ts`）。新增或改名 span 时必须同步本区。

`call_id` / `parent_call_id` 继续描述工具和子 Agent 的业务父子关系；它们不替代 Trace/Span 身份。

## 包装器与适配器

- Runtime SDK 的中性追踪契约定义在
  `red-bean-qing-tuan/src/observability/tracer/port/tracer.ts`；产品侧通过
  `src/shared/observability/tracer.ts` 的 `TracerPort` 隔离 SDK 类型，并只在 Runtime Adapter 边界调用
  `red-bean-qing-tuan/observability` 的包装能力。
- 产品 `src/modules/agent/observability/agent-observability.ts` 包装 `AgentLoader`，并包装加载结果中的
  LLM Adapter 与 Tool Dispatcher；支持子运行装饰能力的 Loader 还会自动包装子 LLM、子
  Tool Dispatcher 和 Child Runner。默认包装器在 `src/modules/agent/agent.module.ts` 中显式组装，
  Chat 与定时任务复用同一套 Agent Module 执行能力。
- `agent.delegate` 记录 agent/execution/parent-call、run/resume、status 及父链路身份；子运行继续使用
  同一个 Trace ID，并在该 span 下建立自己的模型与工具 span。
- `src/infra/observability/provider.ts` 根据配置提供 `StructuredLogTracer` 或 `OTelTracer`。默认
  `StructuredLogTracer` 不初始化网络连接，把 `trace_id`、`span_id`、`parent_span_id`、耗时、状态和低基数
  字段写入结构化日志；`OTelTracer` 把同一中性契约映射到 OpenTelemetry SDK。
- OTel 模式使用 OTLP/HTTP Batch Exporter、`ParentBased(TraceIDRatioBased)` 采样、自定义 IDGenerator
  和包含 `service.name`、`deployment.environment.name` 及 SDK 默认字段的 Resource。产品 Trace ID、
  `X-Trace-ID`、SSE `trace_id` 与 OTel Trace ID 保持一致。
- Provider shutdown 由应用组装层直接登记到 lifecycle，随进程反向关闭并尽力刷新在途 span；初始化和
  关闭错误保留完整上下文。
- HTTP middleware 和 Scheduler 只负责建立根 span 与生成身份；业务 handler、Node 和工具不直接依赖
  具体日志实现或追踪厂商。

Runtime SDK 仍不依赖 OpenTelemetry。Exporter、采样器、资源属性、脱敏和 W3C 传播都位于产品适配器
或部署配置；未来替换 Trace 后端时只改 Provider/包装器，不改 Runtime 和业务逻辑。

## 配置与传播

```yaml
observability:
  exporter: structured # structured | otlp
  service_name: red-bean-nian-gao
  sample_ratio: 1.0 # (0, 1]
```

`OBSERVABILITY_EXPORTER`、`OTEL_SERVICE_NAME`、`OTEL_TRACES_SAMPLER_ARG` 可覆盖上述字段。OTLP endpoint、
TLS、压缩和认证使用 OTel 标准 `OTEL_EXPORTER_OTLP_*` 环境变量；仓库不维护第二套连接配置。

入站合法远端父链路会继承 Trace ID、父 Span ID、采样标记和 `tracestate`。ParentBased 采样首先遵循
远端决定；本地新 Trace 再按 `sample_ratio` 采样。当前没有需要注入 W3C header 的产品出站 HTTP
调用；未来新增此类适配器时复用同一个 propagator，从当前本地 span 注入 `traceparent`。

## 数据与安全边界

- span 属性只记录 ID、名称、状态、计数和耗时等低基数信息。
- 不记录 prompt、模型回复、工具参数、密钥、JWT 或用户上传内容。
- 未捕获错误对外仍只返回安全业务文案；详细错误进入服务端 span/log。
- `TraceID` 用于关联，不承担认证、授权、幂等或取消语义。
- 不信任入站 Trace ID 承载的业务身份；合法性校验只证明其 wire 格式可用于观测关联。
