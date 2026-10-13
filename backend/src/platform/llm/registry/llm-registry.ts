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
  provide(name: string, factory: LlmProviderFactory | null | undefined): void
}

/** 一个 provider 插件；`name` 归一化（trim + 小写）后必须唯一。 */
export interface LlmProviderPlugin {
  readonly name: string
  register(registrar: LlmProviderRegistrar): void
}

class StartupRegistrar implements LlmProviderRegistrar {
  readonly #providers = new Map<string, LlmProviderFactory>()
  #sealed = false

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

  public seal(): void {
    this.#sealed = true
  }

  public snapshot(): ReadonlyMap<string, LlmProviderFactory> {
    return new Map(this.#providers)
  }
}

/** 进程启动时一次性组装并封闭的 Provider 查询表。 */
export class LlmProviderRegistry {
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

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}
