import type { IdGenerator } from '../../../../../shared/id/id-generator.js'
import type { ToolRegistry } from '../../../../../platform/tool/registry/tool-registry.js'
import type { AgentExecutionPort } from '../../../execution/port/agent-executor.js'
import {
  createRuntimeDelegationTool,
  createRuntimeToolDispatcher,
} from '../../../execution/adapter/runtime-tool-adapter.js'
import type {
  AgentChildRunner,
  AgentTool,
  AgentToolDispatcher,
} from '../../../execution/model/agent-execution-contract.js'
import type {
  AgentModelAdapter,
  AgentModelParams,
  AgentRuntimeConfig,
  AgentToolSchema,
} from '../../../execution/model/agent-execution-contract.js'
import type { AgentRuntimeEvent } from '../../../run/model/agent-runtime-event.js'
import type {
  AgentLoadContext,
  ChildRuntimeDecorator,
  SubAgentDisplayRegistryPort,
} from '../../../loader/port/agent-loader.port.js'
import { SectionCollector } from '../../../presentation/service/section-collector.js'
import { RuntimeChildRunner } from '../../adapter/runtime-delegation-runner.js'
import type { SubExecutionRepository } from '../../repository/port/sub-execution-repository.port.js'
import { SubExecutionLifecycle } from '../../run/service/default-sub-execution-lifecycle.js'

/** Loader 交给工具工厂的子 Agent 定义快照，不包含数据库 row 命名。 */
export interface SubAgentToolDefinition {
  readonly agentId: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly systemToolIds: readonly string[]
}

export interface BuildSubAgentToolsRequest {
  readonly definitions: readonly SubAgentToolDefinition[]
  readonly parentAdapter: AgentModelAdapter
  readonly modelName: string
  readonly modelParams: AgentModelParams
  readonly runtimeConfig: AgentRuntimeConfig
  readonly displayRegistry: SubAgentDisplayRegistryPort
  readonly loadContext: AgentLoadContext
}

export interface SubAgentToolSet {
  readonly schemas: readonly AgentToolSchema[]
  readonly dispatcher: AgentToolDispatcher
}

export interface RuntimeSubAgentToolFactoryOptions {
  readonly executor: AgentExecutionPort
  readonly idGenerator: IdGenerator
  readonly registry: ToolRegistry
  readonly repository: SubExecutionRepository
  readonly decorators?: readonly ChildRuntimeDecorator[] | undefined
}

/**
 * 把已加载的子 Agent 定义组装为委派工具。
 * 内部 1:1 实现（无独立 Port），由 `agent.module.ts` 组装，Loader 直接依赖本类；
 * 动态 Runner 的构造属于该 Adapter，Loader 只消费稳定的 build 能力。
 */
export class RuntimeSubAgentToolFactory {
  readonly #options: RuntimeSubAgentToolFactoryOptions

  public constructor(options: RuntimeSubAgentToolFactoryOptions) {
    this.#options = { ...options, decorators: [...(options.decorators ?? [])] }
  }

  /**
   * 追加一个装饰器并返回**新的**工厂实例。
   * 不可变：同一个工厂会并发服务多个父运行的加载，就地追加会让先启动的那些也受影响。
   * 新装饰器追加在末尾，因此已有的在外层（与插件注册的顺序约定一致）。
   */
  public withRuntimeDecorator(decorator: ChildRuntimeDecorator): RuntimeSubAgentToolFactory {
    return new RuntimeSubAgentToolFactory({
      ...this.#options,
      decorators: [...(this.#options.decorators ?? []), decorator],
    })
  }

  public build(request: BuildSubAgentToolsRequest): SubAgentToolSet {
    if (request.definitions.length === 0) {
      return { schemas: [], dispatcher: createRuntimeToolDispatcher([]) }
    }
    const tools = request.definitions.map((definition): AgentTool =>
      this.#createTool(definition, request)
    )
    return {
      schemas: tools.map((tool) => tool.schema),
      dispatcher: createRuntimeToolDispatcher(tools),
    }
  }

  /**
   * 为一个子 Agent 定义造出委派工具。
   *
   * 装饰器在**两个不同层次**被套上，别以为是一处：
   * - `wrapLlm` / `wrapToolDispatcher` 包的是子运行内部的模型与工具（下面的循环）；
   * - `wrapChildRunner` 包的是「发起子运行」这件事本身（函数末尾）。
   * 前者影响子 Agent 怎么干活，后者影响父 Agent 怎么调用它——观测与授权各自需要的是不同的一层。
   *
   * 子执行的工具集取 `definition.systemToolIds`：子 Agent 的工具授权是它自己的，
   * 与父的清单无关，这也是「子 Agent 是独立配置」的体现。
   */
  #createTool(definition: SubAgentToolDefinition, request: BuildSubAgentToolsRequest): AgentTool {
    let adapter = request.parentAdapter
    let dispatcher: AgentToolDispatcher = this.#options.registry.dispatcher(
      definition.systemToolIds
    )
    for (const decorator of this.#options.decorators ?? []) {
      adapter = decorator.wrapLlm?.(adapter) ?? adapter
      dispatcher = decorator.wrapToolDispatcher?.(dispatcher) ?? dispatcher
    }
    const lifecycle = new SubExecutionLifecycle(this.#options.repository, {
      agentId: definition.agentId,
      agentName: definition.name,
      modelName: request.modelName,
      systemPrompt: definition.systemPrompt,
      displayPublisher: {
        publish(data): void {
          const parentCallId = data['parent_call_id']
          if (typeof parentCallId === 'string' && parentCallId !== '') {
            request.displayRegistry.set(parentCallId, data)
          }
        },
      },
    })
    let runner: AgentChildRunner = new RuntimeChildRunner({
      executor: this.#options.executor,
      executionPrefix: 'SAEX',
      idGenerator: this.#options.idGenerator,
      adapter,
      tools: this.#options.registry.schemas(definition.systemToolIds),
      dispatcher,
      systemPrompt: definition.systemPrompt,
      modelParams: request.modelParams,
      runtimeConfig: request.runtimeConfig,
      onMessage: (executionId, persistenceRevision, message, signal): Promise<void> =>
        this.#options.repository.appendRecoveryMessage(
          executionId,
          persistenceRevision,
          message,
          signal
        ),
      lifecycle,
      createSectionCollector: (): SectionCollector => new SectionCollector(),
      stream:
        (executionId, parentCallId): ((event: AgentRuntimeEvent) => void) =>
        (event: AgentRuntimeEvent): void => {
          request.loadContext.eventSink?.({
            type: 'agent_event',
            agentId: definition.agentId,
            agentName: definition.name,
            executionId,
            parentCallId,
            eventType: event.type,
            event,
          })
        },
    })
    for (const decorator of this.#options.decorators ?? []) {
      runner = decorator.wrapChildRunner?.(runner) ?? runner
    }
    return createRuntimeDelegationTool({
      agentId: definition.agentId,
      name: definition.name,
      description: definition.description,
      runner,
    })
  }
}
