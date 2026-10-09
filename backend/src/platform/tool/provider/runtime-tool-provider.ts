import type { Tool } from 'red-bean-qing-tuan/pipeline'
import { lookupBuiltinTool } from 'red-bean-qing-tuan/tools'

import type { ToolProviderPlugin } from '../registry/tool-registry.js'

const CATALOG_TOOL_IDS = Object.freeze(['sys_get_time', 'sys_http_request', 'sys_fetch_url'])

/** 注册 Runtime 内置目录工具以及宿主明确授权的 Runtime 工具。 */
export function runtimeBuiltinProvider(hostTools: readonly Tool[] = []): ToolProviderPlugin {
  const selectedHostTools = [...hostTools]
  return {
    name: 'runtime-builtins',
    register(registrar): void {
      for (const id of CATALOG_TOOL_IDS) {
        const tool = lookupBuiltinTool(id)
        if (tool === undefined) {
          throw new Error(`runtime builtin ${JSON.stringify(id)} is unavailable`)
        }
        registrar.provide(tool)
      }
      for (const [index, tool] of selectedHostTools.entries()) {
        try {
          registrar.provide(tool)
        } catch (cause: unknown) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          throw new Error(
            `provide host-selected Runtime tool at index ${index}: ${error.message}`,
            { cause }
          )
        }
      }
    },
  }
}
