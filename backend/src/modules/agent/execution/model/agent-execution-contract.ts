/*
 * 产品侧的 Runtime 执行契约。这些类型与 SDK 的同名接口**形状对应但不共享定义**，
 * 是刻意的：业务模块只依赖本文件，SDK 类型只在 `execution/adapter/` 的 mapper 里出现。
 * 好处是 SDK 升级时的类型改动被挡在 Adapter 之外，业务层不会被波及。
 */
import type { AgentMessage, AgentToolCall } from '../../model/agent-message.js'
import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'

export interface AgentModelParams {
  readonly temperature?: number | undefined
  readonly maxTokens?: number | undefined
  readonly contextWindow?: number | undefined
  readonly thinking?: boolean | undefined
}

export interface AgentToolSchema {
  readonly type: string
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: AgentJsonObject
  }
  readonly interrupting?: boolean | undefined
}

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

export interface AgentModelRequest {
  readonly messages: readonly AgentMessage[]
  readonly tools: readonly AgentToolSchema[]
  readonly params: AgentModelParams
}

export interface AgentModelChunk {
  readonly content: string | null
  readonly reasoningContent?: string | null | undefined
  readonly toolCalls?: readonly AgentToolCall[] | undefined
  readonly finishReason?: string | null | undefined
  readonly usage?: AgentTokenUsage | undefined
  readonly error?: Error | undefined
}

export interface AgentModelAdapter {
  streamCompletion(
    request: AgentModelRequest,
    signal: AbortSignal
  ): Promise<AsyncIterable<AgentModelChunk>>
}

export type AgentModelAdapterFactory = (
  provider: string,
  apiKey: string,
  baseUrl: string,
  modelName: string
) => AgentModelAdapter

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

export interface AgentTool {
  readonly name: string
  readonly schema: AgentToolSchema
  execute(
    params: AgentJsonValue,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult>
}

export interface AgentToolDispatcher {
  dispatch(
    call: AgentToolCall,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult>
}

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

export interface AgentPostCompactRestorer {
  buildAttachments(
    references: readonly NonNullable<AgentToolResult['preserve']>[],
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]>
}

export interface AgentCompressionConfig {
  readonly enabled?: boolean | undefined
  readonly compressor?: AgentContextCompressor | undefined
  readonly restorer?: AgentPostCompactRestorer | undefined
  readonly triggerThreshold?: number | undefined
  readonly summaryPrompt?: string | undefined
  readonly keepRecent?: number | undefined
  readonly idleTimeoutSeconds?: number | undefined
}

export interface AgentInterrupt {
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: AgentJsonValue
  readonly payload: AgentJsonValue
}

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

export interface AgentChildRunResult {
  readonly status: 'completed' | 'suspended' | 'failed' | 'cancelled' | 'exhausted'
  readonly executionId?: string | undefined
  readonly output?: string | undefined
  readonly partialOutput?: string | undefined
  readonly error?: string | undefined
  readonly interrupt?: AgentInterrupt | undefined
}

export interface AgentChildRunner {
  runChild(request: AgentChildRunRequest, signal: AbortSignal): Promise<AgentChildRunResult>
}
