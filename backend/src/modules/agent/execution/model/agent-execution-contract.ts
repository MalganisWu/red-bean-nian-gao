/*
 * 产品侧的 Runtime 执行契约。这些类型与 SDK 的同名接口**形状对应但不共享定义**，
 * 是刻意的：业务模块只依赖本文件，SDK 类型只在 `execution/adapter/` 的 mapper 里出现。
 * 好处是 SDK 升级时的类型改动被挡在 Adapter 之外，业务层不会被波及。
 */
import type { AgentMessage, AgentToolCall } from '../../model/agent-message.js'
import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'

/** 中性生成参数；各字段可选，未设置即不向下游传递。 */
export interface AgentModelParams {
  /** 采样温度；越高输出越发散。未设置表示沿用 Provider 默认值。 */
  readonly temperature?: number | undefined
  /** 单次回复的 token 上限；未设置表示不额外限制。 */
  readonly maxTokens?: number | undefined
  /** 模型上下文窗口大小；未设置时由 Provider 按所配模型自行决定。 */
  readonly contextWindow?: number | undefined
  /** 是否开启思考（推理）模式；未设置表示不显式开启。 */
  readonly thinking?: boolean | undefined
}

/**
 * 工具的对外 schema。
 * `interrupting` 是给 Runtime 的**静态声明**，决定它能否形成中断屏障——
 * 一个可能要求人工确认的工具必须在这里声明，否则屏障不生效（见 Runtime 的 tool-step）。
 */
export interface AgentToolSchema {
  /** schema 类型标签；OpenAI 兼容约定固定为 `function`。 */
  readonly type: string
  /** 函数描述体：名称、自然语言说明与入参的 JSON Schema，是模型实际看到的那份定义。 */
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: AgentJsonObject
  }
  /** 是否可能要求人工确认；缺省即不需要，此时 Runtime 不会为它建中断屏障。 */
  readonly interrupting?: boolean | undefined
}

/** 一次模型调用的 token 用量。 */
export interface AgentTokenUsage {
  /** 输入（提示）token 数。 */
  readonly promptTokens: number
  /** 输出（补全）token 数。 */
  readonly completionTokens: number
  /** 输入与输出之和；直接取 Provider 返回的值，不在本地重算以免口径漂移。 */
  readonly totalTokens: number
  /**
   * 缓存命中 token（Runtime Adapter 透传 Provider 的 prompt_cache_hit_tokens）。
   * 字段可缺省：Provider 不返回缓存用量时不产生该字段，事实日志侧归一为 null。
   */
  readonly cacheReadTokens?: number | null | undefined
}

/** 一次模型调用的完整中性请求。 */
export interface AgentModelRequest {
  /** 对话历史，按时间顺序排列；最后一条是本轮要模型回应的输入。 */
  readonly messages: readonly AgentMessage[]
  /** 本次调用可用的工具定义；空数组表示不提供工具调用。 */
  readonly tools: readonly AgentToolSchema[]
  /** 采样与窗口相关的生成参数，未设置的字段不向下游传递。 */
  readonly params: AgentModelParams
}

/**
 * 模型流的单个增量。
 * `error` 是带内错误通道：设置它表示这一帧是错的，流本身仍会正常结束，
 * 消费者因此只需处理一种终止方式。`content: null` 合法——工具调用轮次没有正文。
 */
export interface AgentModelChunk {
  /** 正文增量；`null` 合法——工具调用轮次没有正文。 */
  readonly content: string | null
  /** 思考（推理）内容增量；未开启思考或该帧没有思考时为缺省。 */
  readonly reasoningContent?: string | null | undefined
  /** 本帧携带的工具调用；缺省表示本帧没有工具调用。 */
  readonly toolCalls?: readonly AgentToolCall[] | undefined
  /** 结束原因（如 stop / tool_calls / length）；缺省表示流尚未给出终态。 */
  readonly finishReason?: string | null | undefined
  /** 本帧或本轮累计的 token 用量；Provider 不返回时为缺省。 */
  readonly usage?: AgentTokenUsage | undefined
  /** 带内错误通道：设置它表示这一帧是错的，但流本身仍会正常结束。 */
  readonly error?: Error | undefined
}

/** 模型适配器：厂商实现由平台层在启动期注册，业务只依赖本接口。 */
export interface AgentModelAdapter {
  /**
   * 以流式方式发起一次模型调用。
   * 返回的是可异步迭代的增量序列，调用方边收边消费，不必等整轮生成完才拿到内容；
   * 收到取消信号时必须让迭代提前结束，不得把已取消的流继续吐给调用方。
   *
   * @param request - 中性请求：消息、工具与生成参数，已与具体厂商无关。
   * @param signal - 取消信号；中断流式生成并尽快结束迭代。
   * @returns 模型输出增量的异步迭代序列；错误经增量里的 `error` 字段带内传递。
   */
  streamCompletion(
    request: AgentModelRequest,
    signal: AbortSignal
  ): Promise<AsyncIterable<AgentModelChunk>>
}

/** 由 provider 配置造出适配器；实现由 `LlmProviderRegistry` 提供，业务不感知具体厂商。 */
export type AgentModelAdapterFactory = (
  provider: string,
  apiKey: string,
  baseUrl: string,
  modelName: string
) => AgentModelAdapter

/** 工具执行时拿到的调用身份与 checkpoint 位置；工具据此写入并参与 fencing。 */
export interface AgentToolCallContext {
  /** 会话线程 id，用于把工具副作用归到同一条会话。 */
  readonly threadId: string
  /** 发起本次工具调用的用户 id；工具据此做归属校验。 */
  readonly userId: string
  /** 本次运行的请求 id，用于把多次工具调用串回同一次用户请求。 */
  readonly requestId: string
  /** 链路追踪 id；工具据此把日志与 span 接到同一条调用链。 */
  readonly traceId: string
  /** 本次工具调用的唯一 id，与 tool_call 一一对应。 */
  readonly callId: string
  /** 工具执行时刻的 checkpoint 版本；写入时用于发现与并发修改的冲突。 */
  readonly checkpointRevision: bigint
  /** fencing token：lease 被抢占后，旧持有者的写入会因 token 过期而被拒。 */
  readonly fencingToken: bigint
  /** 运行事件出口；工具产生的事件经它回流到 Runtime 事件流，缺省表示不订阅。 */
  readonly eventSink?: ((event: AgentRuntimeEvent) => void) | undefined
}

/**
 * 工具执行结果。`signal` 设置 interrupt 表示要求挂起（此时不产生正文结果）；
 * `preserve` 用于把大块内容登记成引用，而不是塞进 `content` 撑爆上下文。
 */
export interface AgentToolResult {
  /** 工具正文结果；设置 `signal` 挂起时该字段无意义（挂起不产生正文）。 */
  readonly content: string
  /** 设置 interrupt 表示要求挂起，此时不产生正文结果。 */
  readonly signal?: { readonly kind: 'interrupt'; readonly payload: AgentJsonValue } | undefined
  /** 把大块内容登记为引用而非正文的载荷；缺省表示本次结果直接走 `content`。 */
  readonly preserve?:
    | {
        readonly kind: string
        readonly key: string
        readonly version?: string | undefined
        readonly meta?: Readonly<Record<string, string>> | undefined
        readonly timestamp?: number | undefined
        readonly fetch?: ((signal: AbortSignal) => Promise<Uint8Array>) | undefined
      }
    | undefined
}

/** 产品侧的工具定义；`name` 必须与 `schema.function.name` 一致，注册时会校验。 */
export interface AgentTool {
  /** 工具名；必须与 `schema.function.name` 一致，注册时会校验。 */
  readonly name: string
  /** 提供给模型的 schema；决定模型看到的名字、说明与入参结构。 */
  readonly schema: AgentToolSchema
  /**
   * 执行一次工具调用。
   *
   * @param params - 模型给出的入参，形状由 schema 约定，此处仍是未校验的 JSON。
   * @param context - 调用身份与 checkpoint 位置，工具据此写入并参与 fencing。
   * @param signal - 取消信号；工具应尽快中止并停止副作用。
   * @returns 工具结果；需要人工确认时在结果里设置 `signal` 挂起。
   */
  execute(
    params: AgentJsonValue,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult>
}

/** 按名字分发工具调用；授权策略与观测装饰器都包在这一层之外。 */
export interface AgentToolDispatcher {
  /**
   * 按名字把一次工具调用分发到对应实现。
   * 授权策略与观测装饰器都包在本层之外，分发本身只负责找到并执行工具。
   *
   * @param call - 模型给出的工具调用：工具名与入参。
   * @param context - 调用身份与 checkpoint 位置，透传给具体工具。
   * @param signal - 取消信号，透传给具体工具。
   * @returns 被调工具的返回值。
   */
  dispatch(
    call: AgentToolCall,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult>
}

/** 一次运行的运行时参数；来源是 agent 的 `metadata` JSON，由 `DbMainAgentLoader` 解析。 */
export interface AgentRuntimeConfig {
  /** 单轮运行内工具调用的最大迭代次数；达到上限即按 exhausted 收尾。 */
  readonly maxToolIterations?: number | undefined
  /** 单次工具执行的超时秒数；超时按该工具失败处理。 */
  readonly toolTimeoutSeconds?: number | undefined
  /** 同时执行的工具调用上限；超出的调用排队等待。 */
  readonly maxConcurrentTools?: number | undefined
  /** 单次 LLM 调用的最大重试次数（不含首次）。 */
  readonly maxLlmRetries?: number | undefined
  /** LLM 重试的首次退避秒数，后续按指数增长。 */
  readonly llmRetryBackoffSeconds?: number | undefined
  /** LLM 重试退避的封顶秒数，避免退避时长无限增长。 */
  readonly llmRetryBackoffMaxSeconds?: number | undefined
  /** 单次 LLM 调用（含流式接收）的超时秒数。 */
  readonly llmTimeoutSeconds?: number | undefined
  /** 上下文压缩配置；缺省即整套关闭，上下文不会被改写。 */
  readonly compression?: AgentCompressionConfig | undefined
}

/** Pipeline 节点共享的可变运行上下文；`llmContext` 与 `metadata` 会被运行过程改写。 */
export interface AgentRuntimeContext {
  /** 会话 id，本次运行的业务归属。 */
  readonly sessionId: string
  /** 本次运行的 checkpoint id，用于定位与恢复快照。 */
  readonly checkpointId: string
  /** 发起本次运行的用户 id。 */
  readonly userId: string
  /** 本次运行的请求 id，串联同一次用户请求内的各节点。 */
  readonly requestId: string
  /** 链路追踪 id，用于把各节点的日志与 span 归到同一条调用链。 */
  readonly traceId: string
  /** 当前 checkpoint 版本；写入时用于发现并发冲突。 */
  readonly checkpointRevision: bigint
  /** fencing token：lease 被抢占后，旧持有者的写入会因 token 过期而被拒。 */
  readonly fencingToken: bigint
  /** 已提交的消息快照，作为本轮模型对话历史的基准。 */
  readonly messages: readonly AgentMessage[]
  /** Pipeline 节点共享的可变模型上下文；压缩等节点会就地改写它。 */
  llmContext: AgentMessage[]
  /** 跨节点传递的运行时元数据；只活在本次运行内，不落库。 */
  readonly metadata: Map<string, unknown>
  /** 管道中捕获的错误；非 undefined 表示某个节点已失败，后续节点据此短路。 */
  pipelineError: Error | undefined
  /**
   * 生成当前运行的幂等键：同一会话在同一次运行内得到稳定值，用于写入去重。
   *
   * @returns 幂等键字符串；同一次运行内重复调用结果一致。
   */
  checkpointKey(): string
  /**
   * 发出一条运行事件；事件随后经事件出口交给业务编排层。
   *
   * @param event - 要发布的运行事件，已与 SDK 无关的中性形态。
   */
  emit(event: AgentRuntimeEvent): void
}

/** 上下文压缩 Port；`shouldCompact` 只判定不做副作用，压缩本身由 `compress` 完成。 */
export interface AgentContextCompressor {
  /**
   * 判定是否该压缩；只做判断、不产生副作用，压缩动作留给 `compress`。
   *
   * @param context - 当前运行上下文，提供预算与令牌等判定依据。
   * @param messages - 待判定的消息序列，按其规模与轮次决定是否越阈。
   * @param signal - 取消信号；判定被取消时应尽快返回。
   * @returns 是否需要执行压缩。
   */
  shouldCompact(
    context: AgentRuntimeContext,
    messages: readonly AgentMessage[],
    signal: AbortSignal
  ): Promise<boolean>
  /**
   * 执行压缩：把消息序列压成等价的更短序列。
   *
   * @param context - 当前运行上下文，压缩结果需与之保持一致。
   * @param messages - 待压缩的消息序列。
   * @param signal - 取消信号；压缩被取消时抛错，而不是返回半成品。
   * @returns 压缩后的消息序列；调用方以此替换原上下文。
   */
  compress(
    context: AgentRuntimeContext,
    messages: readonly AgentMessage[],
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]>
}

/** 压缩后的内容恢复 Port：按预算把引用的内容取回成附件。 */
export interface AgentPostCompactRestorer {
  /**
   * 按预算把被压缩掉的引用内容取回成附件。
   *
   * @param references - 被登记为引用的内容描述，按保留优先级排列。
   * @param signal - 取消信号；取回被取消时抛错，而不是返回部分附件。
   * @returns 取回的内容附件；预算内无法取回的引用被跳过。
   */
  buildAttachments(
    references: readonly NonNullable<AgentToolResult['preserve']>[],
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]>
}

/** 压缩配置。未显式 `enabled` 时整套关闭——压缩会改写上下文并多花一次模型调用，不该被默默打开。 */
export interface AgentCompressionConfig {
  /** 是否启用压缩；缺省即关闭——压缩会改写上下文并多花一次模型调用，不该被默默打开。 */
  readonly enabled?: boolean | undefined
  /** 压缩器实现；启用了压缩却未注入时视为配置不完整。 */
  readonly compressor?: AgentContextCompressor | undefined
  /** 压缩后的内容恢复器；缺省表示被压缩掉的内容不再取回。 */
  readonly restorer?: AgentPostCompactRestorer | undefined
  /** 触发压缩的上下文占比阈值；达到即触发。 */
  readonly triggerThreshold?: number | undefined
  /** 生成摘要用的提示词；缺省时由压缩器自带默认提示。 */
  readonly summaryPrompt?: string | undefined
  /** 压缩后原样保留的最近消息条数，避免刚用过的上下文被立刻压掉。 */
  readonly keepRecent?: number | undefined
  /** 空闲多久（秒）后允许压缩；缺省表示不按空闲时间触发。 */
  readonly idleTimeoutSeconds?: number | undefined
}

/** 一次挂起：哪个工具、什么参数、以及给宿主展示用的中性载荷。 */
export interface AgentInterrupt {
  /** 触发挂起的工具调用 id，用于把用户作答对回原调用。 */
  readonly toolCallId: string
  /** 触发挂起的工具名，供宿主展示与路由作答。 */
  readonly toolName: string
  /** 工具原始入参；宿主据此渲染确认内容。 */
  readonly arguments: AgentJsonValue
  /** 给宿主展示用的中性载荷，已与具体工具解耦。 */
  readonly payload: AgentJsonValue
}

/** 父运行交给子运行执行器的请求；`executionId` 为空表示新建，非空且带 `resume` 表示续跑。 */
export interface AgentChildRunRequest {
  /** 子 Agent 定义 id，决定用哪套工具与提示词。 */
  readonly agentId: string
  /** 子执行 id；为空表示新建，非空表示定位已有执行。 */
  readonly executionId: string
  /** 父运行里触发本次委派的工具调用 id，用于父子对账。 */
  readonly parentCallId: string
  /** 子运行的会话线程 id；通常与父运行共享同一会话。 */
  readonly threadId: string
  /** 用户 id，沿用父运行的身份，子运行不切换归属。 */
  readonly userId: string
  /** 请求 id，沿用父运行，便于跨父子归并同一次用户请求。 */
  readonly requestId: string
  /** 链路追踪 id，沿用父运行，父子 span 落在同一条调用链。 */
  readonly traceId: string
  /** 交给子 Agent 的指令正文。 */
  readonly instruction: string
  /** 随指令一并提供的上下文文本（例如上游工具的结果）。 */
  readonly context: string
  /** 对输出的格式要求，用于约束子 Agent 的回复形态。 */
  readonly expectedFormat: string
  /** 续跑信息；非空表示从先前的挂起处继续，而非新建。 */
  readonly resume?: { readonly interruptId: string; readonly response: string } | undefined
  /** 子运行事件出口；缺省表示父运行不订阅子运行事件。 */
  readonly eventSink?: ((event: AgentRuntimeEvent) => void) | undefined
}

/** 子运行结果；字段按状态分组，`interrupt` 只在 `suspended` 时必需。 */
export interface AgentChildRunResult {
  /** 子运行终态；决定其余字段哪些有意义。 */
  readonly status: 'completed' | 'suspended' | 'failed' | 'cancelled' | 'exhausted'
  /** 本次子执行 id；新建时由执行器回填，便于后续续跑。 */
  readonly executionId?: string | undefined
  /** 完整输出；仅在 completed 时有意义。 */
  readonly output?: string | undefined
  /** 部分输出；失败或被取消时保留已产生的进展，避免上下文丢失。 */
  readonly partialOutput?: string | undefined
  /** 失败原因；仅在 failed 时出现。 */
  readonly error?: string | undefined
  /** 挂起信息；仅在 suspended 时必需，供父运行作答后续跑。 */
  readonly interrupt?: AgentInterrupt | undefined
}

/** 子运行执行器；失败时应抛带部分结果的错误，而不是返回一个丢了上下文的空失败。 */
export interface AgentChildRunner {
  /**
   * 执行一次子运行：新建或从挂起处续跑。
   *
   * @param request - 子运行请求；按 `executionId` 与 `resume` 决定新建还是续跑。
   * @param signal - 取消信号；取消时中止子运行并尽可能保留部分结果。
   * @returns 子运行结果；失败时以 error / partialOutput 表达，而不是抛一个丢了上下文的空错误。
   */
  runChild(request: AgentChildRunRequest, signal: AbortSignal): Promise<AgentChildRunResult>
}
