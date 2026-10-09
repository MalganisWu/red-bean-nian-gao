import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, it } from 'node:test'

import type { LlmAdapter, LlmChunk } from 'red-bean-qing-tuan/llm'
import type { Attribute, Span, SpanStart, Tracer } from 'red-bean-qing-tuan/observability'
import type { ToolDispatcher, ToolResult } from 'red-bean-qing-tuan/pipeline'
import {
  CHILD_RUN_STATUSES,
  type ChildRunRequest,
  type ChildRunResult,
  type ChildRunner,
} from 'red-bean-qing-tuan/tools'

import { wrapAgentLoader } from '../../../../src/modules/agent/observability/agent-observability.js'
import type {
  AgentBuildConfig,
  AgentLoader,
  ChildRuntimeDecorator,
  ChildRuntimeDecoratableAgentLoader,
} from '../../../../src/modules/agent/loader/port/agent-loader.port.js'

interface RecordedSpan {
  readonly name: string
  readonly depth: number
  readonly attributes: Map<string, string>
  ended: boolean
  error?: Error | undefined
}

class TestSpan implements Span {
  readonly #record: RecordedSpan
  readonly #storage: AsyncLocalStorage<number>

  public constructor(record: RecordedSpan, storage: AsyncLocalStorage<number>) {
    this.#record = record
    this.#storage = storage
  }

  public setAttributes(...attributes: readonly Attribute[]): void {
    for (const attribute of attributes) this.#record.attributes.set(attribute.key, attribute.value)
  }

  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return this.#storage.run(this.#record.depth + 1, operation)
  }

  public end(error?: Error): void {
    this.#record.ended = true
    this.#record.error = error
  }
}

class TestTracer implements Tracer {
  public readonly storage = new AsyncLocalStorage<number>()
  public readonly spans: RecordedSpan[] = []

  public start(start: SpanStart): Span {
    const record: RecordedSpan = {
      name: start.name,
      depth: this.storage.getStore() ?? 0,
      attributes: new Map(
        start.attributes.map((attribute): [string, string] => [attribute.key, attribute.value])
      ),
      ended: false,
    }
    this.spans.push(record)
    return new TestSpan(record, this.storage)
  }
}

class ProbeModel implements LlmAdapter {
  public depth = -1
  readonly #tracer: TestTracer

  public constructor(tracer: TestTracer) {
    this.#tracer = tracer
  }

  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    this.depth = this.#tracer.storage.getStore() ?? 0
    return Promise.resolve(iterableOf([]))
  }
}

class ProbeDispatcher implements ToolDispatcher {
  public depth = -1
  readonly #tracer: TestTracer

  public constructor(tracer: TestTracer) {
    this.#tracer = tracer
  }

  public dispatch(): Promise<ToolResult> {
    this.depth = this.#tracer.storage.getStore() ?? 0
    return Promise.resolve({ content: 'ok' })
  }
}

class StaticLoader implements AgentLoader {
  readonly #config: AgentBuildConfig

  public constructor(config: AgentBuildConfig) {
    this.#config = config
  }

  public load(): Promise<AgentBuildConfig> {
    return Promise.resolve(this.#config)
  }
}

class DecoratableLoader implements ChildRuntimeDecoratableAgentLoader {
  public decorator: ChildRuntimeDecorator | undefined
  public childModel: LlmAdapter | undefined
  public childDispatcher: ToolDispatcher | undefined
  public childRunner: ChildRunner | undefined
  readonly #tracer: TestTracer

  public constructor(tracer: TestTracer) {
    this.#tracer = tracer
  }

  public withChildRuntimeDecorator(decorator: ChildRuntimeDecorator): AgentLoader {
    this.decorator = decorator
    return this
  }

  public load(): Promise<AgentBuildConfig> {
    const model = new ProbeModel(this.#tracer)
    const dispatcher = new ProbeDispatcher(this.#tracer)
    const runner: ChildRunner = {
      runChild(): Promise<ChildRunResult> {
        return Promise.resolve({
          status: CHILD_RUN_STATUSES.COMPLETED,
          executionId: 'SAEX_child',
          output: 'done',
        })
      },
    }
    this.childModel = this.decorator?.wrapLlm?.(model) ?? model
    this.childDispatcher = this.decorator?.wrapToolDispatcher?.(dispatcher) ?? dispatcher
    this.childRunner = this.decorator?.wrapChildRunner?.(runner) ?? runner
    return Promise.resolve({})
  }
}

void describe('product observability wrappers', () => {
  void it('wraps Agent loading, model calls and tool calls', async () => {
    const tracer = new TestTracer()
    const model = new ProbeModel(tracer)
    const dispatcher = new ProbeDispatcher(tracer)
    const loader = wrapAgentLoader(
      tracer,
      new StaticLoader({ llmAdapter: model, toolDispatcher: dispatcher })
    )
    const config = await loader.load('default', new AbortController().signal)
    const signal = new AbortController().signal
    const stream = await config.llmAdapter?.streamCompletion(
      { messages: [], tools: [], params: {} },
      signal
    )
    if (stream !== undefined) await consume(stream)
    await config.toolDispatcher?.dispatch(
      { id: 'call-1', type: 'function', function: { name: 'probe', arguments: '{}' } },
      {
        threadId: 'session-1',
        userId: 'user-1',
        requestId: 'run-1',
        traceId: 'trace-1',
        callId: 'call-1',
        checkpointRevision: 0n,
        fencingToken: 0n,
      },
      signal
    )

    assert.deepEqual(
      tracer.spans.map((span): string => span.name),
      ['agent.load', 'llm.stream', 'tool.execute']
    )
    assert.equal(tracer.spans[0]?.attributes.get('agent.id'), 'default')
    assert.equal(model.depth, 1)
    assert.equal(dispatcher.depth, 1)
    assert.ok(tracer.spans.every((span): boolean => span.ended && span.error === undefined))
  })

  void it('decorates child model, tool and delegation runner', async () => {
    const tracer = new TestTracer()
    const loader = new DecoratableLoader(tracer)
    await wrapAgentLoader(tracer, loader).load('default', new AbortController().signal)
    const signal = new AbortController().signal
    const stream = await loader.childModel?.streamCompletion(
      { messages: [], tools: [], params: {} },
      signal
    )
    if (stream !== undefined) await consume(stream)
    await loader.childDispatcher?.dispatch(
      { id: 'child-tool', type: 'function', function: { name: 'probe', arguments: '{}' } },
      {
        threadId: 'thread-1',
        userId: 'user-1',
        requestId: 'request-1',
        traceId: 'trace-1',
        callId: 'child-tool',
        checkpointRevision: 0n,
        fencingToken: 0n,
      },
      signal
    )
    const request: ChildRunRequest = {
      agentId: 'researcher',
      executionId: '',
      parentCallId: 'parent',
      threadId: 'thread-1',
      userId: 'user-1',
      requestId: 'request-1',
      traceId: 'trace-1',
      instruction: 'work',
      context: '',
      expectedFormat: '',
    }
    await loader.childRunner?.runChild(request, signal)

    assert.deepEqual(
      tracer.spans.map((span): string => span.name),
      ['agent.load', 'llm.stream', 'tool.execute', 'agent.delegate']
    )
    assert.equal(tracer.spans[3]?.attributes.get('agent.execution_id'), 'SAEX_child')
    assert.equal(tracer.spans[3]?.attributes.get('runtime.status'), 'completed')
  })
})

function iterableOf<TValue>(values: readonly TValue[]): AsyncIterable<TValue> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<TValue> {
      let index = 0
      return {
        next(): Promise<IteratorResult<TValue>> {
          const value = values[index]
          index += 1
          return value === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : Promise.resolve({ done: false, value })
        },
      }
    },
  }
}

async function consume<TValue>(values: AsyncIterable<TValue>): Promise<void> {
  for await (const value of values) {
    assert.notEqual(value, undefined)
  }
}
