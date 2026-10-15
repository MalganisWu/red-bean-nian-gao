import type { Tool } from 'red-bean-qing-tuan/tools'
import type { ToolProviderPlugin } from '../registry/tool-registry.js'

/**
 * 注册由各业务 Module 工厂创建、再由 composition root 汇集的产品工具。
 *
 * 这是产品工具进入能力表的唯一通道：Module 工厂只**造**工具，不自己往注册表里塞，
 * 汇集点留在 composition root，因此「这个实例到底有哪些工具」始终是一处可读的清单。
 * @param tools - 各 Module 工厂造出的产品工具；传 `null`/`undefined` 时在注册期抛错而不是当空清单
 * @returns 固定名为 `product-builtins` 的插件；登记时按传入顺序逐个交给 Registry
 */
export function productBuiltinProvider(
  tools: readonly Tool[] | null | undefined
): ToolProviderPlugin {
  return {
    name: 'product-builtins',
    register(registrar): void {
      if (tools === null || tools === undefined) throw new Error('产品工具不能为 null')
      for (const tool of tools) registrar.provide(tool)
    },
  }
}
