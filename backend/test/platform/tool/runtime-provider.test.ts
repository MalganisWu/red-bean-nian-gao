import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool, ToolResult, ToolSchema } from 'red-bean-qing-tuan/pipeline'

import { ToolRegistry } from '../../../src/platform/tool/registry/tool-registry.js'
import { runtimeBuiltinProvider } from '../../../src/platform/tool/provider/runtime-tool-provider.js'

class ReadTool implements Tool {
  public readonly name = 'sys_read_file'
  public readonly schema: ToolSchema = {
    type: 'function',
    function: {
      name: this.name,
      description: 'read',
      parameters: { type: 'object', properties: {} },
    },
  }

  public execute(): Promise<ToolResult> {
    return Promise.resolve({ content: '' })
  }
}

void describe('Runtime builtin provider', () => {
  void it('registers catalog tools and explicit host tools', () => {
    const registry = new ToolRegistry([runtimeBuiltinProvider([new ReadTool()])])
    const ids = ['sys_get_time', 'sys_http_request', 'sys_fetch_url', 'sys_read_file']
    assert.deepEqual(
      registry.schemas(ids).map((schema) => schema.function.name),
      ids
    )
  })
})
