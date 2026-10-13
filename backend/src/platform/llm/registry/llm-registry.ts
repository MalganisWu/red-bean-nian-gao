import type { LlmAdapter, LlmAdapterFactory } from 'red-bean-qing-tuan/llm'
import { normalizeError } from '../../../shared/errors/normalize-error.js'

/** 按凭据造 adapter；返回 `null`/`undefined` 是插件表达「这个配置我造不出来」的方式，不是静默跳过。 */
export type LlmProviderFactory = (
  apiKey: string,
  baseUrl: string,
  modelName: string
) => LlmAdapter | null | undefined

/** 启动期注册入口；注册表封闭后再调用会抛错，杜绝运行时注册带来的不确定行为。 */
export interface LlmProviderRegistrar {
  /**
   * 登记一个 provider 工厂，仅在启动注册期内合法：注册表封闭后再调用会抛错。
   * @param name - provider 名；归一化后为空或与已登记的重复都会抛错
   * @param factory - 造 adapter 的工厂；传 `null` / `undefined` 表示该配置不提供 provider
   */
  provide(name: string, factory: LlmProviderFactory | null | undefined): void
}

/** 一个 provider 插件；`name` 归一化（trim + 小写）后必须唯一。 */
export interface LlmProviderPlugin {
  /** 插件名，启动期用来去重；归一化后为空或重复都会让启动失败。 */
  readonly name: string
  /**
   * 把自己的 provider 登记到注册表；只在启动注册期内被调用一次。
   * @param registrar - 启动期注册入口，插件经由它登记而不是直接改注册表
   */
  register(registrar: LlmProviderRegistrar): void
}

/**
 * 启动期的 provider 登记处，由 `LlmProviderRegistry` 在构造期创建并在 `finally` 中封闭。
 *
 * 封闭（`seal`）是「注册期」与「运行期」的分界线：一旦封闭，`provide` 只抛错不再接受登记。
 * 这样注册表的最终内容完全由构造期的插件列表决定，运行期不会再被改动 —— 进程起来之后
 * provider 表就是一个只读常量，查询结果可稳定重现。
 */
class StartupRegistrar implements LlmProviderRegistrar {
  /** 归一化 provider 名到工厂的映射；登记期不断写入，封闭后不再变动。 */
  readonly #providers = new Map<string, LlmProviderFactory>()
  /** 是否已封闭；`true` 之后 `provide` 一律抛错。 */
  #sealed = false

  /**
   * 登记一个 provider 工厂。
   * 所有校验都放在这里，因为这是 provider 进入系统的唯一入口：名称为空、工厂不是函数、
   * 名称重复都在此处挡下，避免坏数据在运行期表现为「provider 莫名不可用」。
   * @param rawName - provider 名，先做归一化再判空与查重
   * @param factory - 造 adapter 的工厂；不是函数即抛错
   */
  public provide(rawName: string, factory: LlmProviderFactory | null | undefined): void {
    if (this.#sealed) throw new Error('LLM provider registry is sealed')
    const name = normalizeName(rawName)
    if (name === '') throw new Error('LLM provider name must not be empty')
    if (typeof factory !== 'function') {
      throw new TypeError('LLM provider factory must be a function')
    }
    if (this.#providers.has(name)) {
      throw new Error(`LLM provider ${JSON.stringify(name)} already registered`)
    }
    this.#providers.set(name, factory)
  }

  /** 封闭注册处；封闭后 `provide` 只抛错，注册表内容就此固定。 */
  public seal(): void {
    this.#sealed = true
  }

  /**
   * 取当前登记内容的只读副本；复制而不是暴露内部 Map，封闭后的表因此不会被调用方改写。
   * @returns 归一化名称到工厂的只读快照
   */
  public snapshot(): ReadonlyMap<string, LlmProviderFactory> {
    return new Map(this.#providers)
  }
}

/** 进程启动时一次性组装并封闭的 Provider 查询表。 */
export class LlmProviderRegistry {
  /** 构造期封闭后不再变动的静态表；`adapterFactory` 查的就是它。 */
  readonly #providers: ReadonlyMap<string, LlmProviderFactory>

  public constructor(plugins: readonly (LlmProviderPlugin | null | undefined)[]) {
    const registrar = new StartupRegistrar()
    const names = new Set<string>()
    try {
      for (const [index, plugin] of plugins.entries()) {
        if (plugin === null || plugin === undefined) {
          throw new TypeError(`LLM provider plugin at index ${index} must not be null`)
        }
        const name = normalizeName(plugin.name)
        if (name === '') {
          throw new Error(`LLM provider plugin at index ${index} name must not be empty`)
        }
        if (names.has(name)) {
          throw new Error(`duplicate LLM provider plugin ${JSON.stringify(name)}`)
        }
        names.add(name)
        try {
          plugin.register(registrar)
        } catch (cause: unknown) {
          const error = normalizeError(cause)
          throw new Error(
            `register LLM provider plugin ${JSON.stringify(name)}: ${error.message}`,
            { cause }
          )
        }
      }
    } finally {
      registrar.seal()
    }

    this.#providers = registrar.snapshot()
    if (this.#providers.size === 0) {
      throw new Error('at least one LLM provider is required')
    }
  }

  /**
   * 返回给 Runtime SDK 的中性工厂。SDK 只认这个签名，不知道 provider 是怎么查出来的。
   *
   * 三处严格：provider 名归一化后为空即报错；查不到就抛「unsupported」；
   * 工厂返回 `null`/`undefined` 也当作失败——这是 provider 插件表达「这个配置我造不出来」的方式，
   * 静默放过会让 Runtime 拿到一个不是 adapter 的东西，报错位置离根因很远。
   * @returns Runtime SDK 认得的工厂函数；它内部查的是构造期封闭的静态表，运行期不会再变
   */
  public adapterFactory(): LlmAdapterFactory {
    /** 按归一化后的 provider 名查表并构造 adapter；名字为空、查不到或工厂返回空都算失败。 */
    const createAdapter = (
      rawProvider: string,
      apiKey: string,
      baseUrl: string,
      modelName: string
    ): LlmAdapter => {
      const provider = normalizeName(rawProvider)
      if (provider === '') {
        throw new Error('LLM provider name must not be empty')
      }
      const factory = this.#providers.get(provider)
      if (factory === undefined) {
        throw new Error(`unsupported LLM provider ${JSON.stringify(provider)}`)
      }

      let adapter: LlmAdapter | null | undefined
      try {
        adapter = factory(apiKey, baseUrl, modelName)
      } catch (cause: unknown) {
        const error = normalizeError(cause)
        throw new Error(
          `create LLM adapter for provider ${JSON.stringify(provider)}: ${error.message}`,
          { cause }
        )
      }
      if (adapter === null || adapter === undefined) {
        throw new Error(`LLM provider ${JSON.stringify(provider)} returned no adapter`)
      }
      return adapter
    }
    return createAdapter
  }
}

/**
 * 归一化 provider 名：去首尾空白并转小写，让 `"OpenAI"` 与 `" openai "` 视为同一个名字。
 * @param name - 原始 provider 名
 * @returns 归一化后的名字；可能为空串，由调用方判空后决定是否报错
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}
