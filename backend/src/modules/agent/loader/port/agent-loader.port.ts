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
  /**
   * 登记某个子调用的展示数据；生命周期归本次运行所有。
   *
   * @param parentCallId - 子调用在父运行中的调用标识。
   * @param data - 该子调用的展示数据（中性 JSON）。
   */
  set(parentCallId: string, data: AgentJsonValue): void
  /**
   * 读取当前已登记的全部展示数据。
   *
   * @returns 以父调用标识为键的只读视图。
   */
  data(): ReadonlyMap<string, AgentJsonValue>
}

/** 子 Agent 事件在主运行流中的业务信封。 */
export interface SubAgentRuntimeEvent {
  /** 信封判别字段，恒为 `agent_event`。 */
  readonly type: 'agent_event'
  /** 产生该事件的子 Agent 主键。 */
  readonly agentId: string
  /** 子 Agent 的展示名；用于 UI 标识来源。 */
  readonly agentName: string
  /** 本次子执行的标识；与恢复、去重对应。 */
  readonly executionId: string
  /** 父运行中触发该子执行的调用标识。 */
  readonly parentCallId: string
  /** 底层 Runtime 事件的类型名；供投影层分流。 */
  readonly eventType: string
  /** 底层 Runtime 原始事件；保持原貌以便投影复用。 */
  readonly event: AgentRuntimeEvent
}

/** 加载期事件出口承载的事件：Runtime 事件，或带父调用标识的子 Agent 事件。 */
export type AgentStreamEvent = AgentRuntimeEvent | SubAgentRuntimeEvent

/** Agent 加载期间使用的事件出口。 */
export interface AgentLoadContext {
  /** 加载期事件出口；子 Agent 事件经它流向宿主，缺省表示不订阅。 */
  readonly eventSink?: ((event: AgentStreamEvent) => void) | undefined
}

/** 一次运行使用的完整 Agent 配置快照。 */
export interface AgentBuildConfig {
  /** LLM 适配器；由 Loader 按配置构造，缺省表示本次不启用模型调用。 */
  readonly llmAdapter?: AgentModelAdapter | undefined
  /** 工具分派器；负责把工具调用路由到系统工具与子 Agent 委派。 */
  readonly toolDispatcher?: AgentToolDispatcher | undefined
  /** 模型可见的工具 schema 清单；缺省收敛为空数组。 */
  readonly tools?: readonly AgentToolSchema[] | undefined
  /** 系统提示词；缺省收敛为空串。 */
  readonly systemPrompt?: string | undefined
  /** 模型调用参数；缺省交给 Runtime 用自身默认值。 */
  readonly modelParams?: AgentModelParams | undefined
  /** 运行参数（迭代上限、重试、压缩等）；缺省交给 Runtime 默认值。 */
  readonly runtimeConfig?: AgentRuntimeConfig | undefined
  /** 执行前的产品恢复步骤；缺省表示本次运行不做恢复。 */
  readonly preparation?: AgentRunPreparation | undefined
  /** 子执行展示注册表；生命周期归本次运行所有，缺省表示不支持子 Agent 展示。 */
  readonly subAgentDisplayRegistry?: SubAgentDisplayRegistryPort | undefined
  /** 本轮实际路由的 Provider 标识（事实日志 run 容器用）；Loader 无法判定时缺省。 */
  readonly provider?: string | undefined
  /** 本轮实际路由的模型名（事实日志 run 容器用）；Loader 无法判定时缺省。 */
  readonly model?: string | undefined
}

/** Agent 执行前的产品恢复步骤；不得作为 Runtime Node 注入 SDK。 */
export interface AgentRunPreparation {
  /**
   * 在运行开始前执行产品恢复步骤；失败应抛出以阻止本次运行。
   *
   * @param sessionId - 本次运行的会话标识。
   * @param signal - 中止信号，透传给恢复过程。
   */
  prepare(sessionId: string, signal: AbortSignal): Promise<void>
}

/**
 * Agent Module 加载运行配置的出站边界。
 * 默认实现为 `DbMainAgentLoader`，由 `agent.module.ts` 组装；加载结果是单次运行的不可变快照。
 */
export interface AgentLoader {
  /**
   * 加载一次运行所需的配置快照；运行期间不再回查数据库。
   *
   * @param agentId - 目标 agent 主键；不存在或已禁用时应抛错。
   * @param signal - 各次查询的中止信号。
   * @param context - 加载上下文（如恢复策略入参）；缺省为空上下文。
   * @returns 一次运行使用的自洽配置快照。
   */
  load(agentId: string, signal: AbortSignal, context?: AgentLoadContext): Promise<AgentBuildConfig>
}

/** 子 Agent Runtime 观测装饰器，由组装层注入 Loader。 */
export interface ChildRuntimeDecorator {
  /** 装饰子 Agent 的 LLM 适配器；缺省表示不改写。 */
  readonly wrapLlm?: ((adapter: AgentModelAdapter) => AgentModelAdapter) | undefined
  /** 装饰子 Agent 的工具分派器；缺省表示不改写。 */
  readonly wrapToolDispatcher?:
    ((dispatcher: AgentToolDispatcher) => AgentToolDispatcher) | undefined
  /** 装饰子 Agent 的运行器；缺省表示不改写。 */
  readonly wrapChildRunner?: ((runner: AgentChildRunner) => AgentChildRunner) | undefined
}

/**
 * 支持为子 Agent 执行安装启动期装饰器的 Loader 扩展边界。
 * 默认实现为 `DbMainAgentLoader`，由 `agent.module.ts` 包装为最终 `AgentLoader`。
 */
export interface ChildRuntimeDecoratableAgentLoader extends AgentLoader {
  /**
   * 返回换用该子运行装饰器的新 loader；不可变，原实例不受影响。
   *
   * @param decorator - 子运行装饰器；由观测层注入，只作用于此后新建的 loader。
   * @returns 换用该装饰器的新 loader 实例。
   */
  withChildRuntimeDecorator(decorator: ChildRuntimeDecorator): AgentLoader
}
