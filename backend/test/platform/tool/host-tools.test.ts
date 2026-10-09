import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, type TestContext } from 'node:test'

import type { ToolCall, ToolCallContext } from 'red-bean-qing-tuan/pipeline'

import { createHostTools } from '../../../src/platform/tool/provider/host-tools.js'
import { runtimeBuiltinProvider } from '../../../src/platform/tool/provider/runtime-tool-provider.js'
import { ToolRegistry } from '../../../src/platform/tool/registry/tool-registry.js'

/** 产品显式选择的 Runtime 工具，与 `createHostTools` 的组装结果对应。 */
const HOST_TOOL_IDS = Object.freeze([
  'sys_read_file',
  'sys_list_directory',
  'sys_glob',
  'sys_grep',
  'sys_write_file',
  'sys_edit_file',
  'sys_apply_patch',
  'sys_todo_write',
  'sys_shell',
])

function callContext(): ToolCallContext {
  return {
    threadId: 'session-1',
    userId: 'user-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    callId: 'call-1',
    checkpointRevision: 0n,
    fencingToken: 0n,
  }
}

function toolCall(name: string, params: unknown): ToolCall {
  return {
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(params) },
  }
}

function hostRegistry(): ToolRegistry {
  return new ToolRegistry([runtimeBuiltinProvider(createHostTools())])
}

async function temporaryDirectory(test: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'rbng-host-tools-'))
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

void describe('Host tools', () => {
  void it('registers every host-selected tool', () => {
    const registry = hostRegistry()
    assert.deepEqual(
      registry.schemas(HOST_TOOL_IDS).map((schema) => schema.function.name),
      [...HOST_TOOL_IDS]
    )
  })

  void it('lets a read through one tool authorize an edit through another', async (test) => {
    const directory = await temporaryDirectory(test)
    const target = path.join(directory, 'shared.txt')
    await writeFile(target, 'alpha\nbeta\n', 'utf8')

    // 读取与写入是不同实例，只有共享同一个账本时「先读后写」才成立
    const dispatcher = hostRegistry().dispatcher(HOST_TOOL_IDS)
    const signal = AbortSignal.timeout(5_000)

    await dispatcher.dispatch(
      toolCall('sys_read_file', { file_path: target }),
      callContext(),
      signal
    )
    const edited = await dispatcher.dispatch(
      toolCall('sys_edit_file', {
        file_path: target,
        old_string: 'beta',
        new_string: 'BETA',
      }),
      callContext(),
      signal
    )

    assert.match(edited.content, /替换 1 处/)
    assert.equal(await readFile(target, 'utf8'), 'alpha\nBETA\n')
  })

  void it('refuses a write when the conversation never read the file', async (test) => {
    const directory = await temporaryDirectory(test)
    const target = path.join(directory, 'unread.txt')
    await writeFile(target, 'alpha\n', 'utf8')

    const dispatcher = hostRegistry().dispatcher(HOST_TOOL_IDS)
    await assert.rejects(
      dispatcher.dispatch(
        toolCall('sys_write_file', { file_path: target, content: 'overwritten\n' }),
        callContext(),
        AbortSignal.timeout(5_000)
      ),
      /先读/
    )
    assert.equal(await readFile(target, 'utf8'), 'alpha\n')
  })
})
