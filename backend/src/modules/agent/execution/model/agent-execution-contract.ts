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
  readonly temperature?: number | undefined
  readonly maxTokens?: number | undefined
  readonly contextWindow?: number | undefined
  readonly thinking?: boolean | undefined
}

/**
 * 工具的对外 schema。
 * `interrupting` 是给 Runtime 的**静态声明**，决定它能否形成中断屏障——
 * 一个可能要求人工确认的工具必须在这里声明，否则屏障不生效（见 Runtime 的 tool-step）。
 */
export interface AgentToolSchema {
  readonly type: string
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: AgentJsonObject
  }
  readonly interrupting?: boolean | undefined
}

/** 一次模型调用的 token 用量。 */
export interface AgentTokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  /**
   * 缓存命中 token（Runtime Adapter 透传 Provider 的 prompt_cache_hit_tokens）。
   * 字段可缺省：Provider 不返回缓存用量时不产生该字段，事实日志侧归一为 null。
   */
  readonly cacheReadTokens?: number | null | undefined
}

/** 一次模型调用的完整中性请求。 */
export interface AgentModelRequest {
  readonly messages: readonly AgentMessage[]
  readonly tools: readonly AgentToolSchema[]
  readonly params: AgentModelParams
}

/**
 * 模型流的单个增量。
 * `error` 是带内错误通道：设置它表示这一帧是错的，流本身仍会正常结束，
 * 消费者因此只需处理一种终止方式。`content: null` 合法——工具调用轮次没有正文。
 */
export interface AgentModelChunk {
  readonly content: string | null
  readonly reasoningContent?: string | null | undefined
  readonly toolCalls?: readonly AgentToolCall[] | undefined
  readonly finishReason?: string | null | undefined
  readonly usage?: AgentTokenUsage | undefined
  readonly error?: Error | undefined
}

/** 模型适配器：厂商实现由平台层在启动期注册，业务只依赖本接口。 */
export interface AgentModelAdapter {
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
  readonly threadId: string
  readonly userId: string
  readonly requestId: string
  readonly traceId: string
  readonly callId: string
  readonly checkpointRevision: bigint
  readonly fencingToken: bigint
  readonly eventSink?: ((event: AgentRuntimeEvent) => void) | undefined
}

/**
 * 工具执行结果。`signal` 设置 interrupt 表示要求挂起（此时不产生正文结果）；
 * `preserve` 用于把大块内容登记成引用，而不是塞进 `content` 撑爆上下文。
 */
export interface AgentToolResult {
  readonly content: string
  readonly signal?: { readonly kind: 'interrupt'; readonly payload: AgentJsonValue } | undefined
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
  readonly name: string
  readonly schema: AgentToolSchema
  execute(
    params: AgentJsonValue,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult>
}

/** 按名字分发工具调用；授权策略与观测装饰器都包在这一层之外。 */
export interface AgentToolDispatcher {
  dispatch(
    call: AgentToolCall,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult>
}

/** 一次运行的运行时参数；来源是 agent 的 `metadata` JSON，由 `DbMainAgentLoader` 解析。 */
export interface AgentRuntimeConfig {
  readonly maxToolIterations?: number | undefined
  readonly toolTimeoutSeconds?: number | undefined
  readonly maxConcurrentTools?: number | undefined
  readonly maxLlmRetries?: number | undefined
  readonly llmRetryBackoffSeconds?: number | undefined
  readonly llmRetryBackoffMaxSeconds?: number | undefined
  readonly llmTimeoutSeconds?: number | undefined
  readonly compression?: AgentCompressionConfig | undefined
}

/** Pipeline 节点共享的可变运行上下文；`llmContext` 与 `metadata` 会被运行过程改写。 */
export interface AgentRuntimeContext {
  readonly sessionId: string
  readonly checkpointId: string
  readonly userId: string
  readonly requestId: string
  readonly traceId: string
  readonly checkpointRevision: bigint
  readonly fencingToken: bigint
  readonly messages: readonly AgentMessage[]
  llmContext: AgentMessage[]
  readonly metadata: Map<string, unknown>
  pipelineError: Error | undefined
  checkpointKey(): string
  emit(event: AgentRuntimeEvent): void
}

/** 上下文压缩 Port；`shouldCompact` 只判定不做副作用，压缩本身由 `compress` 完成。 */
export interface AgentContextCompressor {
  shouldCompact(
    context: AgentRuntimeContext,
    messages: readonly AgentMessage[],
    signal: AbortSignal
  ): Promise<boolean>
  compress(
    context: AgentRuntimeContext,
    messages: readonly AgentMessage[],
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]>
}

/** 压缩后的内容恢复 Port：按预算把引用的内容取回成附件。 */
export interface AgentPostCompactRestorer {
  buildAttachments(
    references: readonly NonNullable<AgentToolResult['preserve']>[],
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]>
}

/** 压缩配置。未显式 `enabled` 时整套关闭——压缩会改写上下文并多花一次模型调用，不该被默默打开。 */
export interface AgentCompressionConfig {
  readonly enabled?: boolean | undefined
  readonly compressor?: AgentContextCompressor | undefined
  readonly restorer?: AgentPostCompactRestorer | undefined
  readonly triggerThreshold?: number | undefined
  readonly summaryPrompt?: string | undefined
  readonly keepRecent?: number | undefined
  readonly idleTimeoutSeconds?: number | undefined
}

/** 一次挂起：哪个工具、什么参数、以及给宿主展示用的中性载荷。 */
export interface AgentInterrupt {
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: AgentJsonValue
  readonly payload: AgentJsonValue
}

/** 父运行交给子运行执行器的请求；`executionId` 为空表示新建，非空且带 `resume` 表示续跑。 */
export interface AgentChildRunRequest {
  readonly agentId: string
  readonly executionId: string
  readonly parentCallId: string
  readonly threadId: string
  readonly userId: string
  readonly requestId: string
  readonly traceId: string
  readonly instruction: string
  readonly context: string
  readonly expectedFormat: string
  readonly resume?: { readonly interruptId: string; readonly response: string } | undefined
  readonly eventSink?: ((event: AgentRuntimeEvent) => void) | undefined
}

/** 子运行结果；字段按状态分组，`interrupt` 只在 `suspended` 时必需。 */
export interface AgentChildRunResult {
  readonly status: 'completed' | 'suspended' | 'failed' | 'cancelled' | 'exhausted'
  readonly executionId?: string | undefined
  readonly output?: string | undefined
  readonly partialOutput?: string | undefined
  readonly error?: string | undefined
  readonly interrupt?: AgentInterrupt | undefined
}

/** 子运行执行器；失败时应抛带部分结果的错误，而不是返回一个丢了上下文的空失败。 */
export interface AgentChildRunner {
  runChild(request: AgentChildRunRequest, signal: AbortSignal): Promise<AgentChildRunResult>
}
