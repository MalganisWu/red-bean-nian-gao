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
  /** 子 Agent 定义标识；写入执行记录并作为委派工具的 identity。 */
  readonly agentId: string
  /** 子 Agent 展示名；也是委派工具对模型暴露的工具名。 */
  readonly name: string
  /** 委派工具描述；模型据此判断何时该把任务交给这个子 Agent。 */
  readonly description: string
  /** 子 Agent 系统提示词；作为子运行执行定义的一部分。 */
  readonly systemPrompt: string
  /** 授权给子 Agent 的系统工具 id 列表；子 Agent 的工具授权独立于父清单。 */
  readonly systemToolIds: readonly string[]
}

/** 一次构建请求：本次加载到的子 Agent 定义，外加父运行共享的模型、运行参数与展示注册表。 */
export interface BuildSubAgentToolsRequest {
  /** 本次加载到的子 Agent 定义快照；逐个组装成委派工具。 */
  readonly definitions: readonly SubAgentToolDefinition[]
  /** 父运行的模型适配器；子运行默认复用它，装饰器可再包装。 */
  readonly parentAdapter: AgentModelAdapter
  /** 父运行使用的模型名；写入子执行记录用于展示。 */
  readonly modelName: string
  /** 父运行的模型参数；透传给子运行执行定义。 */
  readonly modelParams: AgentModelParams
  /** 父运行的运行时配置；透传给子运行执行定义。 */
  readonly runtimeConfig: AgentRuntimeConfig
  /** 展示注册表；子执行展示载荷按父调用 id 登记在此。 */
  readonly displayRegistry: SubAgentDisplayRegistryPort
  /** 本次加载上下文；其事件出口用于把子运行事件投递给父流。 */
  readonly loadContext: AgentLoadContext
}

/** 构建结果：给模型看的 schema 列表与实际分发用的 dispatcher，两者必须出自同一批工具。 */
export interface SubAgentToolSet {
  /** 给模型看的工具 schema 列表。 */
  readonly schemas: readonly AgentToolSchema[]
  /** 实际分发调用的 dispatcher；与 schemas 出自同一批工具，必须成对使用。 */
  readonly dispatcher: AgentToolDispatcher
}

/** 工厂依赖；`decorators` 可缺省，追加请走 `withRuntimeDecorator`（返回新实例，不就地改）。 */
export interface RuntimeSubAgentToolFactoryOptions {
  /** 执行器；子运行与主运行共用同一条执行链路。 */
  readonly executor: AgentExecutionPort
  /** ID 生成器；新建子执行时分配 executionId。 */
  readonly idGenerator: IdGenerator
  /** 工具注册表；按 systemToolIds 取子 Agent 的 schema 与 dispatcher。 */
  readonly registry: ToolRegistry
  /** 子执行仓储；交给动态组装的子执行生命周期使用。 */
  readonly repository: SubExecutionRepository
  /** 子运行装饰器；缺省为空，追加请走 `withRuntimeDecorator`。 */
  readonly decorators?: readonly ChildRuntimeDecorator[] | undefined
}

/**
 * 把已加载的子 Agent 定义组装为委派工具。
 * 内部 1:1 实现（无独立 Port），由 `agent.module.ts` 组装，Loader 直接依赖本类；
 * 动态 Runner 的构造属于该 Adapter，Loader 只消费稳定的 build 能力。
 */
export class RuntimeSubAgentToolFactory {
  /** 构造时固定的依赖与装饰器快照；实例不可变，追加装饰器返回新实例。 */
  readonly #options: RuntimeSubAgentToolFactoryOptions

  public constructor(options: RuntimeSubAgentToolFactoryOptions) {
    this.#options = { ...options, decorators: [...(options.decorators ?? [])] }
  }

  /**
   * 追加一个装饰器并返回**新的**工厂实例。
   * 不可变：同一个工厂会并发服务多个父运行的加载，就地追加会让先启动的那些也受影响。
   * 新装饰器追加在末尾，因此已有的在外层（与插件注册的顺序约定一致）。
   *
   * @param decorator - 待追加的子运行装饰器；追加在末尾，已有装饰器仍在外层
   * @returns 含新装饰器的新工厂实例；原实例不变
   */
  public withRuntimeDecorator(decorator: ChildRuntimeDecorator): RuntimeSubAgentToolFactory {
    return new RuntimeSubAgentToolFactory({
      ...this.#options,
      decorators: [...(this.#options.decorators ?? []), decorator],
    })
  }

  /**
   * 把定义快照逐个组装为委派工具，产出模型可见的 schema 与分发 dispatcher。
   * 二者出自同一批工具，必须成对使用，否则模型看到的清单与实际分派会错位。
   *
   * @param request - 本次构建请求：定义快照与父运行共享的模型、参数与展示注册表
   * @returns schema 列表与 dispatcher；无定义时 schema 为空、dispatcher 为空表
   */
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
   *
   * @param definition - 目标子 Agent 定义快照，决定工具名、描述与工具授权。
   * @param request - 本次构建请求，提供父运行的模型、参数与展示注册表。
   * @returns 组装完成的委派工具；runner 已按装饰器层层包装。
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
    // 把子运行事件包成父运行的 agent_event，投递到本次加载记录的事件出口。
    function publishChildEvent(
      executionId: string,
      parentCallId: string,
      event: AgentRuntimeEvent
    ): void {
      request.loadContext.eventSink?.({
        type: 'agent_event',
        agentId: definition.agentId,
        agentName: definition.name,
        executionId,
        parentCallId,
        eventType: event.type,
        event,
      })
    }

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
        (event: AgentRuntimeEvent): void =>
          publishChildEvent(executionId, parentCallId, event),
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
