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
  /**
   * 登记一个工具，仅在启动注册期内合法：登记处封闭后再调用会抛错。
   * @param tool - 待登记的工具；为 `null` / `undefined`、名字为空、名字与 schema 不一致或重名都会抛错
   */
  provide(tool: Tool | null | undefined): void
}

/** 一个工具提供方插件；`name` 归一化后必须唯一，`register` 里登记它拥有的全部工具。 */
export interface ToolProviderPlugin {
  /** 插件名，启动期用来去重；为空或重复都会让启动失败。 */
  readonly name: string
  /**
   * 把自己的全部工具登记到登记处；只在启动注册期内被调用一次。
   * @param registrar - 启动期登记入口，插件经由它登记而不是直接改注册表
   */
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
  /** 工具名到工具实例的映射；登记期不断写入，封闭后不再变动。 */
  readonly #tools = new Map<string, Tool>()
  /** 是否已封闭；`true` 之后 `provide` 一律抛错。 */
  #sealed = false

  /**
   * 登记一个工具，并在这里完成全部校验。
   * @param tool - 待登记的工具；为 `null` / `undefined`、名字为空或带首尾空白、
   *   名字与 `schema.function.name` 不一致、重名都会抛错
   */
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

  /** 封闭登记处；封闭后 `provide` 只抛错，工具表内容就此固定。 */
  public seal(): void {
    this.#sealed = true
  }

  /**
   * 取当前登记内容的只读副本；复制而不是暴露内部 Map，封闭后的表因此不会被调用方改写。
   * @returns 工具名到工具实例的只读快照
   */
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
  /** 系统工具分发表；优先命中它，只有它报 `NOT_FOUND` 时才会去问委派表。 */
  readonly #system: ToolDispatcher
  /** 子 Agent 委派分发表；仅在系统表未命中时接手。 */
  readonly #delegation: ToolDispatcher

  public constructor(system: ToolDispatcher, delegation: ToolDispatcher) {
    this.#system = system
    this.#delegation = delegation
  }

  /**
   * 分发一次调用：先查系统工具，仅当结果为 `NOT_FOUND` 才把同一次调用交给委派表。
   * 其它错误（工具存在但执行失败）原样抛出，不再去委派表试一次，避免把「工具出错」
   * 变成「工具不存在」或造成重复执行。
   * @param call - 模型发起的工具调用
   * @param context - 本次调用的上下文
   * @param signal - 取消信号，向下透传给被选中的分发器
   * @returns 被选中分发器的结果
   */
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
  /** 构造期封闭后不再变动的静态表；所有查询都基于它。 */
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
   * @param ids - 期望的工具 ID 列表，通常来自 agent 的数据库授权字段；顺序即返回顺序
   * @returns 命中工具的 schema 数组；未命中的 ID 被跳过，因此长度可能小于入参
   */
  public schemas(ids: readonly string[]): readonly ToolSchema[] {
    const schemas: ToolSchema[] = []
    for (const id of ids) {
      const tool = this.#tools.get(id)
      if (tool !== undefined) schemas.push(tool.schema)
    }
    return schemas
  }

  /**
   * 为给定 ID 列表造一个只认识这些工具的分发器。
   * 与 `schemas` 一致，未知 ID 被静默跳过；重复 ID 会先去重，避免同一工具被登记两次。
   * @param ids - 授权工具 ID 列表；未授权或已不存在的工具不在分发范围内
   * @returns 作用域限定的分发器；它只认命中的工具，其余一律按「工具不存在」失败
   */
  public dispatcher(ids: readonly string[]): ToolDispatcher {
    return new MapToolDispatcher(this.#requestedTools(ids))
  }

  /**
   * 系统工具 + 子 Agent 委派的组合分发器；Agent Loader 用的就是它。
   * 路由规则是「先查系统工具，仅当报 `NOT_FOUND` 才回落委派」，
   * 因此传入的系统工具一旦存在，其执行失败不会被委派层掩盖成别的错误。
   * @param systemIds - 该系统内可用的系统工具 ID 列表，语义与 `dispatcher` 的入参一致
   * @param delegation - 系统工具未命中时接手的委派分发器，通常来自 Runtime 的子 Agent 能力
   * @returns 合并后的单一分发器；对模型而言两类工具共享一个命名空间
   */
  public compositeDispatcher(
    systemIds: readonly string[],
    delegation: ToolDispatcher
  ): ToolDispatcher {
    return new CompositeDispatcher(this.dispatcher(systemIds), delegation)
  }

  /**
   * 去重后取出工具实例：授权列表里重复的 ID 不该让同一个工具被注册两次（后者会覆盖前者）。
   * 未知 ID 静默跳过，与 `schemas` 的容错策略一致。
   * @param ids - 授权工具 ID 列表
   * @returns 去重且过滤掉未知 ID 后的工具实例数组，顺序即入参顺序
   */
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
