import type { Tool } from 'red-bean-qing-tuan/tools'
import type { ToolProviderPlugin } from '../registry/tool-registry.js'

/**
 * 注册由各业务 Module 工厂创建、再由 composition root 汇集的产品工具。
 *
 * 这是产品工具进入能力表的唯一通道：Module 工厂只**造**工具，不自己往注册表里塞，
 * 汇集点留在 composition root，因此「这个实例到底有哪些工具」始终是一处可读的清单。
 */
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
