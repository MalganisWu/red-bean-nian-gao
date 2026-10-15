import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  Tool,
  ToolCall,
  ToolCallContext,
  ToolDispatcher,
  ToolResult,
  ToolSchema,
} from 'red-bean-qing-tuan/pipeline'

import {
  ToolRegistry,
  type ToolProviderPlugin,
  type ToolRegistrar,
} from '../../../src/platform/tool/registry/tool-registry.js'

const CONTEXT: ToolCallContext = Object.freeze({
  threadId: 'thread-1',
  userId: 'user-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  callId: 'call-1',
  checkpointRevision: 1n,
  fencingToken: 1n,
})

class FakeTool implements Tool {
  public readonly name: string
  public readonly schema: ToolSchema
  readonly #result: ToolResult
  readonly #error: Error | undefined

  public constructor(
    name: string,
    options: {
      readonly schemaName?: string
      readonly content?: string
      readonly error?: Error
    } = {}
  ) {
    this.name = name
    this.schema = {
      type: 'function',
      function: {
        name: options.schemaName ?? name,
        description: 'test tool',
        parameters: { type: 'object', properties: {} },
      },
    }
    this.#result = { content: options.content ?? '' }
    this.#error = options.error
  }

  public execute(): Promise<ToolResult> {
    return this.#error === undefined ? Promise.resolve(this.#result) : Promise.reject(this.#error)
  }
}

function plugin(name: string, register: (registrar: ToolRegistrar) => void): ToolProviderPlugin {
  return { name, register }
}

function provide(name: string, ...tools: readonly Tool[]): ToolProviderPlugin {
  return plugin(name, (registrar): void => {
    for (const tool of tools) registrar.provide(tool)
  })
}

function call(name: string): ToolCall {
  return {
    id: 'call-1',
    type: 'function',
    function: { name, arguments: '{}' },
  }
}

void describe('TypeScript tool registry', () => {
  void it('composes plugins and preserves requested schema order', async () => {
    const registry = new ToolRegistry([
      provide('first', new FakeTool('tool_a', { content: 'a' })),
      provide('second', new FakeTool('tool_b', { content: 'b' })),
    ])

    assert.deepEqual(
      registry.schemas(['tool_b', 'missing', 'tool_a']).map((schema) => schema.function.name),
      ['tool_b', 'tool_a']
    )
    assert.deepEqual(registry.schemas(['missing']), [])
    const result = await registry
      .dispatcher(['tool_a'])
      .dispatch(call('tool_a'), CONTEXT, new AbortController().signal)
    assert.equal(result.content, 'a')
  })

  void it('falls back to delegation only for an unknown system tool', async () => {
    const systemError = new Error('system tool failed')
    const registry = new ToolRegistry([
      provide('system', new FakeTool('system_tool', { error: systemError })),
    ])
    const delegated: string[] = []
    const delegation: ToolDispatcher = {
      dispatch(toolCall: ToolCall): Promise<ToolResult> {
        delegated.push(toolCall.function.name)
        return Promise.resolve({ content: 'delegated' })
      },
    }
    const dispatcher = registry.compositeDispatcher(['system_tool'], delegation)

    await assert.rejects(
      dispatcher.dispatch(call('system_tool'), CONTEXT, new AbortController().signal),
      systemError
    )
    assert.deepEqual(delegated, [])

    const result = await dispatcher.dispatch(
      call('delegated_tool'),
      CONTEXT,
      new AbortController().signal
    )
    assert.equal(result.content, 'delegated')
    assert.deepEqual(delegated, ['delegated_tool'])
  })

  void it('rejects invalid startup composition', () => {
    assert.throws(() => new ToolRegistry([]), /至少需要一个工具/)
    assert.throws(() => new ToolRegistry([null]), /插件不能为 null/)
    assert.throws(() => new ToolRegistry([plugin(' ', (): void => {})]), /名字不能为空/)
    assert.throws(
      () =>
        new ToolRegistry([
          provide('valid', new FakeTool('tool_a')),
          provide(' VALID ', new FakeTool('tool_b')),
        ]),
      /工具 provider 插件重复/
    )
    assert.throws(
      () =>
        new ToolRegistry([plugin('missing-tool', (registrar): void => registrar.provide(null))]),
      /工具不能为 null/
    )
    assert.throws(
      () => new ToolRegistry([provide('empty-tool', new FakeTool(''))]),
      /工具名不能为空/
    )
    assert.throws(
      () => new ToolRegistry([provide('whitespace-tool', new FakeTool(' tool_a '))]),
      /首尾不能有空白/
    )
    assert.throws(
      () =>
        new ToolRegistry([provide('mismatch', new FakeTool('tool_a', { schemaName: 'tool_b' }))]),
      /与 schema 函数名 .* 不一致/
    )
    assert.throws(
      () =>
        new ToolRegistry([
          provide('first', new FakeTool('tool_a')),
          provide('second', new FakeTool('tool_a')),
        ]),
      /已注册/
    )
    assert.throws(
      () =>
        new ToolRegistry([
          plugin('broken', (): void => {
            throw new Error('registration failed')
          }),
        ]),
      /注册工具 provider 插件 "broken" 失败：registration failed/
    )
  })

  void it('seals registration after startup', () => {
    let captured: ToolRegistrar | undefined
    const registry = new ToolRegistry([
      plugin('capture', (registrar): void => {
        captured = registrar
        registrar.provide(new FakeTool('tool_a'))
      }),
    ])
    assert.ok(registry)
    if (captured === undefined) throw new Error('registrar was not captured')
    const sealedRegistrar = captured
    assert.throws(() => sealedRegistrar.provide(new FakeTool('late_tool')), /注册表已封存/)
  })
})
