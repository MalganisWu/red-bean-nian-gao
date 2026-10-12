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

/** 给 Loader 套上观测装饰；支持子运行装饰的 Loader 会同时拿到 LLM / 工具 / 子运行三层 wrapper。 */
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

class TracedAgentLoader implements AgentLoader {
  readonly #tracer: TracerPort
  readonly #next: AgentLoader

  public constructor(tracer: TracerPort, next: AgentLoader) {
    this.#tracer = tracer
    this.#next = next
  }

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

function compactAttributes(
  ...attributes: readonly { readonly key: string; readonly value: string }[]
): readonly { readonly key: string; readonly value: string }[] {
  return attributes.filter((attribute): boolean => attribute.value !== '')
}

function isChildDecoratableLoader(value: AgentLoader): value is ChildRuntimeDecoratableAgentLoader {
  return (
    'withChildRuntimeDecorator' in value && typeof value.withChildRuntimeDecorator === 'function'
  )
}
