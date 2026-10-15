import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LlmAdapter, LlmChunk, LlmRequest } from 'red-bean-qing-tuan/llm'
import {
  createInterruptSignal,
  type RawMessage,
  type ToolDispatcher,
  type ToolResult,
  type ToolSchema,
} from 'red-bean-qing-tuan/pipeline'
import type { IdGenerator } from '../../../../src/shared/id/id-generator.js'
import { CHILD_RUN_STATUSES, ChildRunError, type ChildRunRequest } from 'red-bean-qing-tuan/tools'

import { RuntimeChildRunner } from '../../../../src/modules/agent/subagent/adapter/runtime-delegation-runner.js'
import type {
  ChildExecutionIdentity,
  ChildExecutionLifecycle,
} from '../../../../src/modules/agent/subagent/run/port/child-execution-lifecycle.port.js'
import { RuntimeAgentExecutor } from '../../../../src/modules/agent/execution/adapter/runtime-agent-executor.js'
import type { StoredRuntimeState } from '../../../../src/modules/agent/execution/model/runtime-state.js'
import { runtimeState } from '../../../helpers/runtime-state.js'

class RecordingIdGenerator implements IdGenerator {
  public readonly prefixes: string[] = []

  public generate(prefix: string): string {
    this.prefixes.push(prefix)
    return 'SAEX_001'
  }
}

class RecordingAdapter implements LlmAdapter {
  public request: LlmRequest | undefined
  public calls = 0
  public chunks: readonly LlmChunk[] = []

  public streamCompletion(request: LlmRequest): Promise<AsyncIterable<LlmChunk>> {
    this.calls += 1
    this.request = request
    const chunks = this.chunks
    return Promise.resolve(iterableOf(chunks))
  }
}

class StaticDispatcher implements ToolDispatcher {
  public result: ToolResult = { content: '' }

  public dispatch(): Promise<ToolResult> {
    return Promise.resolve(this.result)
  }
}

class CaptureLifecycle implements ChildExecutionLifecycle {
  public identity: ChildExecutionIdentity | undefined
  public state: StoredRuntimeState | undefined

  public load(identity: ChildExecutionIdentity): Promise<{
    readonly state?: StoredRuntimeState
    readonly recoveryMessages: readonly RawMessage[]
  }> {
    this.identity = identity
    return Promise.resolve({
      ...(this.state === undefined ? {} : { state: this.state }),
      recoveryMessages: [],
    })
  }
  public save(): Promise<void> {
    return Promise.resolve()
  }
}

class RecordingHook {
  public readonly toolMessages: RawMessage[] = []

  public onMessage(_executionId: string, message: RawMessage): Promise<void> {
    if (message.role === 'tool') this.toolMessages.push(structuredClone(message))
    return Promise.resolve()
  }
}

const EMPTY_REQUEST: ChildRunRequest = Object.freeze({
  agentId: '',
  executionId: '',
  parentCallId: '',
  threadId: '',
  userId: '',
  requestId: '',
  traceId: '',
  instruction: '',
  context: '',
  expectedFormat: '',
})

function assistantChunk(content: string): LlmChunk {
  return { content, finishReason: 'stop' }
}

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

void describe('product Runtime child runner parity', () => {
  void it('creates the execution context and envelopes child events', async () => {
    const idGenerator = new RecordingIdGenerator()
    const adapter = new RecordingAdapter()
    adapter.chunks = [assistantChunk('child completed')]
    const capture = new CaptureLifecycle()
    const parentEvents: unknown[] = []
    const childEvents: unknown[] = []
    const parentSink = (event: unknown): void => {
      parentEvents.push(event)
    }
    const runner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      executionPrefix: 'SAEX',
      idGenerator,
      adapter,
      dispatcher: new StaticDispatcher(),
      systemPrompt: 'system',
      lifecycle: capture,
      stream(executionId, parentCallId, receivedParentSink) {
        assert.equal(executionId, 'SAEX_001')
        assert.equal(parentCallId, 'parent-call')
        assert.equal(receivedParentSink, parentSink)
        return (event): void => {
          childEvents.push(event)
        }
      },
    })
    const result = await runner.runChild(
      {
        ...EMPTY_REQUEST,
        agentId: 'researcher',
        parentCallId: 'parent-call',
        threadId: 'thread-1',
        userId: 'user-1',
        requestId: 'request-1',
        traceId: 'trace-1',
        instruction: 'research',
        context: 'known',
        expectedFormat: 'markdown',
        eventSink: parentSink,
      },
      new AbortController().signal
    )
    assert.deepEqual(result, {
      status: CHILD_RUN_STATUSES.COMPLETED,
      executionId: 'SAEX_001',
      output: 'child completed',
    })
    assert.deepEqual(idGenerator.prefixes, ['SAEX'])
    assert.equal(capture.identity?.executionId, 'SAEX_001')
    assert.equal(capture.identity?.sessionId, 'thread-1')
    assert.equal(capture.identity?.requestId, 'request-1')
    assert.equal(capture.identity?.agentId, 'researcher')
    assert.equal(capture.identity?.parentCallId, 'parent-call')
    assert.ok(childEvents.length > 0)
    assert.equal(parentEvents.length, 0)
    const last = adapter.request?.messages.at(-1)
    assert.equal(last?.role, 'user')
    assert.match(last?.content ?? '', /research/)
    assert.match(last?.content ?? '', /known/)
    assert.match(last?.content ?? '', /markdown/)
  })

  void it('resumes only the unique pending interrupt and preserves an empty response', async () => {
    const adapter = new RecordingAdapter()
    adapter.chunks = [assistantChunk('resumed')]
    const hook = new RecordingHook()
    const capture = new CaptureLifecycle()
    const history: readonly RawMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'interrupt-pending',
            type: 'function',
            function: { name: 'approval', arguments: '{}' },
          },
        ],
      },
    ]
    const runner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      adapter,
      dispatcher: new StaticDispatcher(),
      onMessage: (executionId, _persistenceRevision, message): Promise<void> =>
        hook.onMessage(executionId, message),
      lifecycle: capture,
    })
    capture.state = runtimeState(history, {
      status: 'suspended',
      interrupt: {
        toolCallId: 'interrupt-pending',
        toolName: 'approval',
        arguments: {},
        payload: {},
      },
    })
    const result = await runner.runChild(
      {
        ...EMPTY_REQUEST,
        executionId: 'SAEX_existing',
        resume: { interruptId: 'interrupt-pending', response: '' },
      },
      new AbortController().signal
    )
    assert.equal(result.status, CHILD_RUN_STATUSES.COMPLETED)
    assert.equal(result.output, 'resumed')
    const answer = adapter.request?.messages.at(-1)
    assert.deepEqual(answer, { role: 'tool', content: '', toolCallId: 'interrupt-pending' })
    assert.deepEqual(hook.toolMessages, [answer])
    assert.equal(capture.identity?.interruptId, 'interrupt-pending')
  })

  void it('rejects a stale resume before calling the model', async () => {
    const adapter = new RecordingAdapter()
    const lifecycle = new CaptureLifecycle()
    lifecycle.state = runtimeState(
      [
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'current',
              type: 'function',
              function: { name: 'approval', arguments: '{}' },
            },
          ],
        },
      ],
      {
        status: 'suspended',
        interrupt: { toolCallId: 'current', toolName: 'approval', arguments: {}, payload: {} },
      }
    )
    const runner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      adapter,
      dispatcher: new StaticDispatcher(),
      lifecycle,
    })
    await assert.rejects(
      runner.runChild(
        {
          ...EMPTY_REQUEST,
          executionId: 'SAEX_existing',
          resume: { interruptId: 'stale', response: 'approved' },
        },
        new AbortController().signal
      ),
      /interrupt ID 与挂起的 checkpoint 不符/u
    )
    assert.equal(adapter.calls, 0)
  })

  void it('returns a suspended result with the interrupt', async () => {
    const adapter = new RecordingAdapter()
    adapter.chunks = [
      {
        content: null,
        toolCalls: [
          {
            id: 'call_ask',
            type: 'function',
            function: { name: 'sys_ask_user', arguments: '{"questions":[]}' },
          },
        ],
      },
    ]
    const dispatcher = new StaticDispatcher()
    dispatcher.result = { content: '', signal: createInterruptSignal({ kind: 'ask' }) }
    const schema: ToolSchema = {
      type: 'function',
      function: { name: 'sys_ask_user', description: '', parameters: {} },
      interrupting: true,
    }
    const runner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      executionPrefix: 'SAEX',
      idGenerator: new RecordingIdGenerator(),
      adapter,
      dispatcher,
      tools: [schema],
    })
    const result = await runner.runChild(
      { ...EMPTY_REQUEST, instruction: 'work' },
      new AbortController().signal
    )
    assert.equal(result.status, CHILD_RUN_STATUSES.SUSPENDED)
    assert.equal(result.executionId, 'SAEX_001')
    assert.equal(result.interrupt?.toolCallId, 'call_ask')
  })

  void it('classifies cancellation, partial failure and iteration exhaustion', async () => {
    const cancelledAdapter = new RecordingAdapter()
    const cancelledRunner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      executionPrefix: 'SAEX',
      idGenerator: new RecordingIdGenerator(),
      adapter: cancelledAdapter,
      dispatcher: new StaticDispatcher(),
    })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const cancelled = await cancelledRunner.runChild(
      { ...EMPTY_REQUEST, instruction: 'work' },
      controller.signal
    )
    assert.equal(cancelled.status, CHILD_RUN_STATUSES.CANCELLED)
    assert.equal(cancelled.error, '子 Agent 被取消')
    assert.equal(cancelledAdapter.calls, 0)

    const failedAdapter = new RecordingAdapter()
    failedAdapter.chunks = [
      { content: 'partial answer' },
      { content: null, error: new Error('stream boom') },
    ]
    const failedRunner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      executionPrefix: 'SAEX',
      idGenerator: new RecordingIdGenerator(),
      adapter: failedAdapter,
      dispatcher: new StaticDispatcher(),
    })
    await assert.rejects(
      failedRunner.runChild(
        { ...EMPTY_REQUEST, instruction: 'work' },
        new AbortController().signal
      ),
      (error: unknown): boolean => {
        assert.ok(error instanceof ChildRunError)
        assert.equal(error.result.status, CHILD_RUN_STATUSES.FAILED)
        assert.equal(error.result.partialOutput, 'partial answer')
        assert.match(error.message, /stream boom/)
        return true
      }
    )

    const exhaustedAdapter = new RecordingAdapter()
    const exhaustedRunner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      executionPrefix: 'SAEX',
      idGenerator: new RecordingIdGenerator(),
      adapter: exhaustedAdapter,
      dispatcher: new StaticDispatcher(),
      runtimeConfig: { maxToolIterations: 0 },
    })
    const exhausted = await exhaustedRunner.runChild(
      { ...EMPTY_REQUEST, instruction: 'work' },
      new AbortController().signal
    )
    assert.equal(exhausted.status, CHILD_RUN_STATUSES.EXHAUSTED)
    assert.match(exhausted.error ?? '', /最大工具迭代次数/)
    assert.equal(exhaustedAdapter.calls, 0)
  })

  void it('requires an ID generator only for a new execution', async () => {
    const runner = new RuntimeChildRunner({
      executor: new RuntimeAgentExecutor(),
      adapter: new RecordingAdapter(),
      dispatcher: new StaticDispatcher(),
    })
    await assert.rejects(
      runner.runChild({ ...EMPTY_REQUEST, instruction: 'work' }, new AbortController().signal),
      (error: unknown): boolean => {
        assert.ok(error instanceof ChildRunError)
        assert.equal(error.result.status, CHILD_RUN_STATUSES.FAILED)
        assert.equal(error.result.executionId, undefined)
        return true
      }
    )
  })
})
