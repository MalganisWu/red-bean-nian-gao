import type { Tool } from 'red-bean-qing-tuan/pipeline'
import { lookupBuiltinTool } from 'red-bean-qing-tuan/tools'

import type { ToolProviderPlugin } from '../registry/tool-registry.js'

/**
 * 来自 Runtime 内置目录的三个工具。
 * 选它们而不是别的，是因为 `lookupBuiltinTool` 只认这三个——目录工具的判据是「无副作用且可随时新建实例」，
 * 像文件读写那类需要注入账本与路径策略的，不在目录里，只能由宿主显式构造（见 `createHostTools`）。
 */
const CATALOG_TOOL_IDS = Object.freeze(['sys_get_time', 'sys_http_request', 'sys_fetch_url'])

/**
 * 注册 Runtime 内置目录工具以及宿主明确授权的 Runtime 工具。
 *
 * 目录工具缺失时**直接抛错**而不是跳过：这只可能发生在产品依赖的 SDK 版本被换掉时，
 * 静默跳过会让 agent 少一个工具却毫无提示，而这类版本错配恰恰是必须立刻发现的那种问题。
 * @param hostTools - 宿主显式选择的 Runtime 工具，通常来自 `createHostTools`；缺省即只注册目录工具
 * @returns 固定名为 `runtime-builtins` 的插件；目录工具按固定顺序先登记，宿主工具紧随其后
 */
export function runtimeBuiltinProvider(hostTools: readonly Tool[] = []): ToolProviderPlugin {
  const selectedHostTools = [...hostTools]
  return {
    name: 'runtime-builtins',
    register(registrar): void {
      for (const id of CATALOG_TOOL_IDS) {
        const tool = lookupBuiltinTool(id)
        if (tool === undefined) {
          throw new Error(`Runtime 内置工具 ${JSON.stringify(id)} 不可用`)
        }
        registrar.provide(tool)
      }
      for (const [index, tool] of selectedHostTools.entries()) {
        try {
          registrar.provide(tool)
        } catch (cause: unknown) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          throw new Error(`提供第 ${index} 个宿主选定的 Runtime 工具失败：${error.message}`, {
            cause,
          })
        }
      }
    },
  }
}
