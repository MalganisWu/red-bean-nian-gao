import type { Tool } from 'red-bean-qing-tuan/tools'
import type { ToolProviderPlugin } from '../registry/tool-registry.js'

/** 注册由各业务 Module 工厂创建、再由 composition root 汇集的产品工具。 */
export function productBuiltinProvider(
  tools: readonly Tool[] | null | undefined
): ToolProviderPlugin {
  return {
    name: 'product-builtins',
    register(registrar): void {
      if (tools === null || tools === undefined) throw new Error('product tools must not be null')
      for (const tool of tools) registrar.provide(tool)
    },
  }
}
