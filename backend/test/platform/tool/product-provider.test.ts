import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Tool } from 'red-bean-qing-tuan/tools'

import { productBuiltinProvider } from '../../../src/platform/tool/provider/product-tool-provider.js'
import { ToolRegistry } from '../../../src/platform/tool/registry/tool-registry.js'

function stubTool(name: string): Tool {
  return {
    name,
    schema: { type: 'function', function: { name, description: '', parameters: {} } },
    execute: (): Promise<{ readonly content: string }> => Promise.resolve({ content: '' }),
  }
}

void describe('product builtin provider', () => {
  void it('registers ask-user and scheduled-task tools', () => {
    const registry = new ToolRegistry([
      productBuiltinProvider([stubTool('sys_ask_user'), stubTool('sys_scheduled_task_manage')]),
    ])

    assert.deepEqual(
      registry
        .schemas(['sys_ask_user', 'sys_scheduled_task_manage'])
        .map((schema): string => schema.function.name),
      ['sys_ask_user', 'sys_scheduled_task_manage']
    )
  })

  void it('rejects missing dependencies during startup composition', () => {
    assert.throws(
      () => new ToolRegistry([productBuiltinProvider(null)]),
      /product tools must not be null/u
    )
  })
})
