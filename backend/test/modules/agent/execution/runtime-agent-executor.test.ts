import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LlmAdapter, LlmChunk } from 'red-bean-qing-tuan/llm'
import type { ToolDispatcher, ToolResult } from 'red-bean-qing-tuan/pipeline'

import { RuntimeAgentExecutor } from '../../../../src/modules/agent/execution/adapter/runtime-agent-executor.js'

class SequenceAdapter implements LlmAdapter {
  readonly #responses: readonly (readonly LlmChunk[])[]
  #index = 0

  public constructor(responses: readonly (readonly LlmChunk[])[]) {
    this.#responses = responses
  }

  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    const chunks = this.#responses[this.#index] ?? []
    this.#index += 1
    return Promise.resolve(
      (async function* (): AsyncIterable<LlmChunk> {
        await Promise.resolve()
        for (const chunk of chunks) yield chunk
      })()
    )
  }
}

class EmptyDispatcher implements ToolDispatcher {
  public dispatch(): Promise<ToolResult> {
    return Promise.reject(new Error('测试未注册工具'))
  }
}

void describe('Runtime Agent executor adapter', () => {
  void it('maps a business command to Runtime and returns one opaque state snapshot', async () => {
    const messages: string[] = []
    const executor = new RuntimeAgentExecutor()
    const outcome = await executor.execute(
      {
        kind: 'run',
        sessionId: 'session-1',
        userId: 'user-1',
        runId: 'request-1',
        traceId: 'trace-1',
        definition: {
          model: new SequenceAdapter([[{ content: '完成' }]]),
          dispatcher: new EmptyDispatcher(),
          tools: [],
          systemPrompt: '',
          modelParams: {},
          runtimeConfig: {},
        },
        messages: [{ role: 'user', content: '开始' }],
        messageObserver: {
          observe(message): Promise<void> {
            messages.push(message.role)
            return Promise.resolve()
          },
        },
      },
      AbortSignal.timeout(1_000)
    )

    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.output, '完成')
    assert.equal(outcome.state.engine, 'qing-tuan')
    assert.equal(outcome.state.payload['thread_id'], 'session-1')
    assert.deepEqual(messages, ['user', 'assistant'])
  })

  void it('rejects a stored state whose envelope and payload versions disagree', async () => {
    const executor = new RuntimeAgentExecutor()
    await assert.rejects(
      executor.execute(
        {
          kind: 'run',
          sessionId: 'session-1',
          userId: 'user-1',
          runId: 'request-1',
          traceId: 'trace-1',
          definition: {
            model: new SequenceAdapter([]),
            dispatcher: new EmptyDispatcher(),
            tools: [],
            systemPrompt: '',
            modelParams: {},
            runtimeConfig: {},
          },
          state: {
            engine: 'qing-tuan',
            version: 2,
            payload: {
              version: 1,
              thread_id: 'session-1',
              user_id: 'user-1',
              status: 'completed',
              messages: [],
            },
          },
        },
        AbortSignal.timeout(1_000)
      ),
      /Runtime 状态版本不一致/u
    )
  })
})
