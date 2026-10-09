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

export interface ToolRegistrar {
  provide(tool: Tool | null | undefined): void
}

export interface ToolProviderPlugin {
  readonly name: string
  register(registrar: ToolRegistrar): void
}

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

  public compositeDispatcher(
    systemIds: readonly string[],
    delegation: ToolDispatcher
  ): ToolDispatcher {
    return new CompositeDispatcher(this.dispatcher(systemIds), delegation)
  }

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
