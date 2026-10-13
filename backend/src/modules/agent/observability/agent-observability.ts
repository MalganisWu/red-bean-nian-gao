import type { TracerPort } from '../../../shared/observability/tracer.js'
import {
  wrapRuntimeChildRunner,
  wrapRuntimeModel,
  wrapRuntimeToolDispatcher,
} from '../execution/adapter/runtime-observability-adapter.js'
import { normalizeError } from '../../../shared/errors/normalize-error.js'
import type {
  AgentChildRunner,
  AgentModelAdapter,
  AgentToolDispatcher,
} from '../execution/model/agent-execution-contract.js'
import type {
  AgentBuildConfig,
  AgentLoadContext,
  AgentLoader,
  ChildRuntimeDecoratableAgentLoader,
} from '../loader/port/agent-loader.port.js'

/**
 * 给 Loader 套上观测装饰；支持子运行装饰的 Loader 会同时拿到 LLM / 工具 / 子运行三层 wrapper。
 * @param tracer 产品侧的中性 Tracer
 * @param source 被装饰的 Loader；若支持子运行装饰则另行包上三层 wrapper
 * @returns 记录 agent.load span 并透传配置的 Loader
 */
export function wrapAgentLoader(tracer: TracerPort, source: AgentLoader): AgentLoader {
  const next = isChildDecoratableLoader(source)
    ? source.withChildRuntimeDecorator({
        wrapLlm: (adapter): AgentModelAdapter => wrapRuntimeModel(tracer, adapter),
        wrapToolDispatcher: (dispatcher): AgentToolDispatcher =>
          wrapRuntimeToolDispatcher(tracer, dispatcher),
        wrapChildRunner: (runner): AgentChildRunner => wrapRuntimeChildRunner(tracer, runner),
      })
    : source
  return new TracedAgentLoader(tracer, next)
}

/** 记录 `agent.load` span 的 Loader 装饰器；不改变配置语义，只在成功与失败两侧都结束 span。 */
class TracedAgentLoader implements AgentLoader {
  /** 中性 Tracer；`agent.load` span 由它开启与结束。 */
  readonly #tracer: TracerPort
  /** 被装饰的 Loader；本类只在它的调用两端记 span，不改写配置语义。 */
  readonly #next: AgentLoader

  public constructor(tracer: TracerPort, next: AgentLoader) {
    this.#tracer = tracer
    this.#next = next
  }

  /**
   * 加载配置并为其包一个 `agent.load` span：成功与抛错都结束 span，失败时记录归一化后的错误对象。
   * 返回的配置若带 LLM 适配器或工具分派器，会各再包一层观测 wrapper，保证下游调用同样可见。
   * @param agentId 目标 agent 主键
   * @param signal 加载期间各次查询的中止信号
   * @param context 加载上下文，原样透传给被装饰的 Loader
   * @returns 装配完成、各能力已包观测 wrapper 的配置快照
   */
  public async load(
    agentId: string,
    signal: AbortSignal,
    context?: AgentLoadContext
  ): Promise<AgentBuildConfig> {
    const span = this.#tracer.start({
      name: 'agent.load',
      attributes: compactAttributes({ key: 'agent.id', value: agentId }),
    })
    try {
      const config = await span.within((): Promise<AgentBuildConfig> =>
        this.#next.load(agentId, signal, context)
      )
      span.end()
      return {
        ...config,
        ...(config.llmAdapter === undefined
          ? {}
          : { llmAdapter: wrapRuntimeModel(this.#tracer, config.llmAdapter) }),
        ...(config.toolDispatcher === undefined
          ? {}
          : { toolDispatcher: wrapRuntimeToolDispatcher(this.#tracer, config.toolDispatcher) }),
      }
    } catch (cause: unknown) {
      span.end(normalizeError(cause))
      throw cause
    }
  }
}

/**
 * 过滤掉 value 为空的属性项。
 * 空字符串属性在 span 里没有信息量，反而会干扰按属性筛选，故在入 span 前剔除。
 * @param attributes 属性项序列；value 为空字符串的会被丢弃
 * @returns 仅含非空 value 的属性数组
 */
function compactAttributes(
  ...attributes: readonly { readonly key: string; readonly value: string }[]
): readonly { readonly key: string; readonly value: string }[] {
  return attributes.filter((attribute): boolean => attribute.value !== '')
}

/**
 * 运行时判定 Loader 是否支持子运行装饰。
 * 用结构判定而非 instanceof：装饰链上的 Loader 可能来自不同实现，这里只关心它是否提供该方法。
 * @param value 待判定的 Loader
 * @returns 具备 withChildRuntimeDecorator 方法时为 true，据此可安全调用
 */
function isChildDecoratableLoader(value: AgentLoader): value is ChildRuntimeDecoratableAgentLoader {
  return (
    'withChildRuntimeDecorator' in value && typeof value.withChildRuntimeDecorator === 'function'
  )
}
