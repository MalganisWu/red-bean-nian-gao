import type {
  Tool,
  ToolCall,
  ToolCallContext,
  ToolDispatcher,
  ToolResult,
  ToolSchema,
} from 'red-bean-qing-tuan/pipeline'
import { normalizeError } from '../../../shared/errors/normalize-error.js'
import {
  MapToolDispatcher,
  TOOL_DISPATCH_ERROR_CODES,
  ToolDispatchError,
} from 'red-bean-qing-tuan/tools'

/** 启动期工具登记入口；登记处封闭后再调用会抛错，杜绝运行期注册。 */
export interface ToolRegistrar {
  provide(tool: Tool | null | undefined): void
}

/** 一个工具提供方插件；`name` 归一化后必须唯一，`register` 里登记它拥有的全部工具。 */
export interface ToolProviderPlugin {
  readonly name: string
  register(registrar: ToolRegistrar): void
}

/**
 * 启动期的工具登记处，构造结束后立即 `seal()`。
 *
 * 校验全部集中在 `provide`，因为这里是工具进入系统的唯一入口——
 * 名字为空的工具无法被模型调用，带首尾空白的名字会与 schema 里的名字对不上，
 * 而 `name` 与 `schema.function.name` 不一致则会让「模型看到的工具」和「分发时找的工具」
 * 指向两个不同的东西。这些错误都只在运行期表现为「工具莫名不可用」，所以在这里挡住。
 */
class StartupRegistrar implements ToolRegistrar {
  readonly #tools = new Map<string, Tool>()
  #sealed = false

  public provide(tool: Tool | null | undefined): void {
    if (this.#sealed) throw new Error('tool registry is sealed')
    if (tool === null || tool === undefined) {
      throw new TypeError('tool must not be null')
    }
    const name = tool.name.trim()
    if (name === '') throw new Error('tool name must not be empty')
    if (name !== tool.name) {
      throw new Error(
        `tool name ${JSON.stringify(tool.name)} must not contain surrounding whitespace`
      )
    }
    if (tool.schema.function.name !== name) {
      throw new Error(
        `tool name ${JSON.stringify(name)} does not match schema function name ${JSON.stringify(tool.schema.function.name)}`
      )
    }
    if (this.#tools.has(name)) {
      throw new Error(`tool ${JSON.stringify(name)} already registered`)
    }
    this.#tools.set(name, tool)
  }

  public seal(): void {
    this.#sealed = true
  }

  public snapshot(): ReadonlyMap<string, Tool> {
    return new Map(this.#tools)
  }
}

/**
 * 把「系统工具」与「子 Agent 委派」两个分发表合并成一个。
 *
 * 对模型而言工具只有一个命名空间，它分不清哪个来自哪里，所以分发时必须按名字自动路由。
 * **只有 `NOT_FOUND` 才回落到委派**：一个已经存在但执行失败的工具必须原样报错，
 * 再拿去委派表试一次会把「工具出错」变成「工具不存在」或更糟的重复执行。
 */
class CompositeDispatcher implements ToolDispatcher {
  readonly #system: ToolDispatcher
  readonly #delegation: ToolDispatcher

  public constructor(system: ToolDispatcher, delegation: ToolDispatcher) {
    this.#system = system
    this.#delegation = delegation
  }

  public async dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal
  ): Promise<ToolResult> {
    try {
      return await this.#system.dispatch(call, context, signal)
    } catch (error: unknown) {
      if (
        error instanceof ToolDispatchError &&
        error.code === TOOL_DISPATCH_ERROR_CODES.NOT_FOUND
      ) {
        return this.#delegation.dispatch(call, context, signal)
      }
      throw normalizeError(error)
    }
  }
}

/** 由静态链接插件组装并在启动后封闭的工具能力表。 */
export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, Tool>

  public constructor(plugins: readonly (ToolProviderPlugin | null | undefined)[]) {
    const registrar = new StartupRegistrar()
    const names = new Set<string>()
    try {
      for (const [index, plugin] of plugins.entries()) {
        if (plugin === null || plugin === undefined) {
          throw new TypeError(`tool provider plugin at index ${index} must not be null`)
        }
        const name = plugin.name.trim().toLowerCase()
        if (name === '') {
          throw new Error(`tool provider plugin at index ${index} name must not be empty`)
        }
        if (names.has(name)) {
          throw new Error(`duplicate tool provider plugin ${JSON.stringify(name)}`)
        }
        names.add(name)
        try {
          plugin.register(registrar)
        } catch (cause: unknown) {
          const error = normalizeError(cause)
          throw new Error(
            `register tool provider plugin ${JSON.stringify(name)}: ${error.message}`,
            { cause }
          )
        }
      }
    } finally {
      registrar.seal()
    }

    this.#tools = registrar.snapshot()
    if (this.#tools.size === 0) throw new Error('at least one tool is required')
  }

  /**
   * 取指定 ID 对应的 schema。
   * **未知 ID 静默跳过**而不是报错：agent 的授权列表存在数据库里，
   * 引用了某个已被移除的工具是正常的历史残留，不该让整个 agent 起不来——
   * 它只是少一个工具而已。
   */
  public schemas(ids: readonly string[]): readonly ToolSchema[] {
    const schemas: ToolSchema[] = []
    for (const id of ids) {
      const tool = this.#tools.get(id)
      if (tool !== undefined) schemas.push(tool.schema)
    }
    return schemas
  }

  public dispatcher(ids: readonly string[]): ToolDispatcher {
    return new MapToolDispatcher(this.#requestedTools(ids))
  }

  /** 系统工具 + 子 Agent 委派的组合分发器；Agent Loader 用的就是它。 */
  public compositeDispatcher(
    systemIds: readonly string[],
    delegation: ToolDispatcher
  ): ToolDispatcher {
    return new CompositeDispatcher(this.dispatcher(systemIds), delegation)
  }

  /** 去重后取出工具实例：授权列表里重复的 ID 不该让同一个工具被注册两次（后者会覆盖前者）。 */
  #requestedTools(ids: readonly string[]): readonly Tool[] {
    const tools: Tool[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const tool = this.#tools.get(id)
      if (tool !== undefined) tools.push(tool)
    }
    return tools
  }
}
