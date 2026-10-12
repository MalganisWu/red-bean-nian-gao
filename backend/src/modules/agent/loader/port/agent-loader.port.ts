import type {
  AgentChildRunner,
  AgentModelAdapter,
  AgentModelParams,
  AgentRuntimeConfig,
  AgentToolDispatcher,
  AgentToolSchema,
} from '../../execution/model/agent-execution-contract.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import type { AgentJsonValue } from '../../model/json-value.js'

/**
 * Agent Module 内 Loader 与运行服务共享的子执行展示注册窄接口。
 * 默认实现为 `SubExecDisplayRegistry`，由 `DbMainAgentLoader` 为单次加载创建；生命周期归本次运行所有。
 */
export interface SubAgentDisplayRegistryPort {
  set(parentCallId: string, data: AgentJsonValue): void
  data(): ReadonlyMap<string, AgentJsonValue>
}

/** 子 Agent 事件在主运行流中的业务信封。 */
export interface SubAgentRuntimeEvent {
  readonly type: 'agent_event'
  readonly agentId: string
  readonly agentName: string
  readonly executionId: string
  readonly parentCallId: string
  readonly eventType: string
  readonly event: AgentRuntimeEvent
}

/** 加载期事件出口承载的事件：Runtime 事件，或带父调用标识的子 Agent 事件。 */
export type AgentStreamEvent = AgentRuntimeEvent | SubAgentRuntimeEvent

/** Agent 加载期间使用的事件出口。 */
export interface AgentLoadContext {
  readonly eventSink?: ((event: AgentStreamEvent) => void) | undefined
}

/** 一次运行使用的完整 Agent 配置快照。 */
export interface AgentBuildConfig {
  readonly llmAdapter?: AgentModelAdapter | undefined
  readonly toolDispatcher?: AgentToolDispatcher | undefined
  readonly tools?: readonly AgentToolSchema[] | undefined
  readonly systemPrompt?: string | undefined
  readonly modelParams?: AgentModelParams | undefined
  readonly runtimeConfig?: AgentRuntimeConfig | undefined
  readonly preparation?: AgentRunPreparation | undefined
  readonly subAgentDisplayRegistry?: SubAgentDisplayRegistryPort | undefined
  /** 本轮实际路由的 Provider 标识（事实日志 run 容器用）；Loader 无法判定时缺省。 */
  readonly provider?: string | undefined
  /** 本轮实际路由的模型名（事实日志 run 容器用）；Loader 无法判定时缺省。 */
  readonly model?: string | undefined
}

/** Agent 执行前的产品恢复步骤；不得作为 Runtime Node 注入 SDK。 */
export interface AgentRunPreparation {
  prepare(sessionId: string, signal: AbortSignal): Promise<void>
}

/**
 * Agent Module 加载运行配置的出站边界。
 * 默认实现为 `DbMainAgentLoader`，由 `agent.module.ts` 组装；加载结果是单次运行的不可变快照。
 */
export interface AgentLoader {
  load(agentId: string, signal: AbortSignal, context?: AgentLoadContext): Promise<AgentBuildConfig>
}

/** 子 Agent Runtime 观测装饰器，由组装层注入 Loader。 */
export interface ChildRuntimeDecorator {
  readonly wrapLlm?: ((adapter: AgentModelAdapter) => AgentModelAdapter) | undefined
  readonly wrapToolDispatcher?:
    ((dispatcher: AgentToolDispatcher) => AgentToolDispatcher) | undefined
  readonly wrapChildRunner?: ((runner: AgentChildRunner) => AgentChildRunner) | undefined
}

/**
 * 支持为子 Agent 执行安装启动期装饰器的 Loader 扩展边界。
 * 默认实现为 `DbMainAgentLoader`，由 `agent.module.ts` 包装为最终 `AgentLoader`。
 */
export interface ChildRuntimeDecoratableAgentLoader extends AgentLoader {
  withChildRuntimeDecorator(decorator: ChildRuntimeDecorator): AgentLoader
}
