import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AgentNode,
  RuntimeContext,
  type JsonValue,
  type ToolCall,
  type ToolCallContext,
  type ToolDispatcher,
  type ToolResult,
  type ToolSchema,
} from 'red-bean-qing-tuan/pipeline'
import type { LlmAdapter, LlmChunk, LlmRequest } from 'red-bean-qing-tuan/llm'

import {
  DISPLAY_MESSAGES_METADATA_KEY,
  PresentationInterruptAssembler,
  installLoadedDisplayMessages,
} from '../../../../src/modules/agent/presentation/service/presentation-interrupt-assembler.js'
import { DisplayMessageCollector } from '../../../../src/modules/agent/presentation/service/display-message-collector.js'
import { SectionCollector } from '../../../../src/modules/agent/presentation/service/section-collector.js'

const SIGNAL = AbortSignal.timeout(1_000)

class ScriptedAdapter implements LlmAdapter {
  readonly #chunks: readonly LlmChunk[]
  public readonly requests: LlmRequest[] = []

  public constructor(chunks: readonly LlmChunk[]) {
    this.#chunks = chunks
  }

  public streamCompletion(request: LlmRequest): Promise<AsyncIterable<LlmChunk>> {
    this.requests.push(request)
    return Promise.resolve(stream(this.#chunks))
  }
}

class ResultDispatcher implements ToolDispatcher {
  readonly #result: ToolResult
  public readonly calls: ToolCall[] = []
  public readonly contexts: ToolCallContext[] = []

  public constructor(result: ToolResult) {
    this.#result = result
  }

  public dispatch(
    call: ToolCall,
    context: ToolCallContext,
    signal: AbortSignal
  ): Promise<ToolResult> {
    signal.throwIfAborted()
    this.calls.push(call)
    this.contexts.push(context)
    return Promise.resolve(this.#result)
  }
}

void describe('product presentation adapter', () => {
  void it('projects an interrupted AgentNode run into one pending ask card', async () => {
    const display = new DisplayMessageCollector({ now: (): number => 10 })
    const context = newContext()
    const node = new AgentNode({
      adapter: new ScriptedAdapter([
        {
          content: null,
          toolCalls: [
            {
              id: 'call_ask',
              type: 'function',
              function: {
                name: 'sys_ask_user',
                arguments: '{"questions":[{"id":"q1","text":"继续吗？"}]}',
              },
            },
          ],
        },
      ]),
      dispatcher: new ResultDispatcher({
        content: '',
        signal: { kind: 'interrupt', payload: { kind: 'ask' } },
      }),
      tools: [interruptingTool('sys_ask_user')],
      hook: display,
      interruptAssembler: new PresentationInterruptAssembler(display, {
        now: (): number => 11,
        buildSections: (): JsonValue => [
          {
            type: 'tool_group',
            tools: [
              { callId: 'call_lookup', name: 'sys_lookup' },
              { callId: 'call_ask', name: 'sys_ask_user' },
            ],
          },
        ],
      }),
      systemPrompt: '',
      modelParams: {},
      config: {},
    })

    await node.execute(context, SIGNAL)

    assert.equal(display.messages.length, 2)
    const cardMessage = display.messages[1]
    assert.deepEqual(cardMessage?.sections, [
      {
        type: 'tool_group',
        tools: [{ callId: 'call_lookup', name: 'sys_lookup' }],
      },
      {
        type: 'card',
        card: {
          interaction_id: 'call_ask',
          status: 'pending',
          questions: [{ id: 'q1', text: '继续吗？' }],
        },
        timestamp: 11,
      },
    ])
    assert.equal(
      context.metadata.get('agent_result') !== undefined,
      true,
      'AgentNode must finish as awaiting_user rather than a normal final response'
    )
  })

  void it('does not create an ask card for a completed AgentNode run', async () => {
    const display = new DisplayMessageCollector({ now: (): number => 20 })
    const context = newContext()
    const node = new AgentNode({
      adapter: new ScriptedAdapter([{ content: '完成' }]),
      dispatcher: new ResultDispatcher({ content: '' }),
      tools: [],
      hook: display,
      interruptAssembler: new PresentationInterruptAssembler(display),
      systemPrompt: '',
      modelParams: {},
      config: {},
    })

    await node.execute(context, SIGNAL)

    assert.equal(display.messages.length, 2)
    assert.equal(display.messages.some(hasPendingCard), false)
    assert.equal(display.messages[1]?.content, '完成')
  })

  void it('collects visible user and final assistant messages with stable content sections', async () => {
    const display = new DisplayMessageCollector({ now: (): number => 30 })
    const context = newContext()

    await display.onUserMessage(context, { role: 'user', content: '你好' }, SIGNAL)
    await display.onAssistantMessage(
      context,
      { role: 'assistant', content: '你好，我可以帮忙。' },
      SIGNAL
    )

    assert.deepEqual(display.messages, [
      { role: 'user', content: '你好', timestamp: 30 },
      {
        role: 'assistant',
        content: '你好，我可以帮忙。',
        meta: { runStartedAt: 30 },
        sections: [{ type: 'content', content: '你好，我可以帮忙。', timestamp: 30 }],
        timestamp: 30,
      },
    ])
  })

  void it('does not project assistant tool-call envelopes into display messages', async () => {
    const display = new DisplayMessageCollector({ now: (): number => 40 })
    const context = newContext()

    await display.onAssistantMessage(
      context,
      {
        role: 'assistant',
        content: '正在查询',
        toolCalls: [
          {
            id: 'call_fetch',
            type: 'function',
            function: { name: 'sys_fetch_url', arguments: '{}' },
          },
        ],
      },
      SIGNAL
    )
    await display.onAssistantMessage(context, { role: 'assistant', content: '查询完成' }, SIGNAL)

    assert.deepEqual(display.messages, [
      {
        role: 'assistant',
        content: '查询完成',
        meta: { runStartedAt: 40 },
        sections: [{ type: 'content', content: '查询完成', timestamp: 40 }],
        timestamp: 40,
      },
    ])
  })

  void it('copies loaded display history into Runtime metadata without exposing mutable session state', () => {
    const context = newContext()
    const history = [{ role: 'assistant', content: '上一轮回复', timestamp: 50 }]

    installLoadedDisplayMessages(context, history)
    const restored = context.metadata.get(DISPLAY_MESSAGES_METADATA_KEY)

    assert.deepEqual(restored, history)
    assert.notEqual(restored, history)
    history[0] = { role: 'assistant', content: '外部篡改', timestamp: 50 }
    assert.deepEqual(context.metadata.get(DISPLAY_MESSAGES_METADATA_KEY), [
      { role: 'assistant', content: '上一轮回复', timestamp: 50 },
    ])
  })

  void it('persists the same reason, tool and content sections emitted to the live stream', async () => {
    let now = 100
    const sections = new SectionCollector((): number => now)
    sections.collect({ type: 'reason', content: '先分析', step: 1, timestamp: 90 })
    now = 110
    sections.collect({
      type: 'tool_start',
      toolName: 'sys_get_time',
      callId: 'call_1',
      params: { timezone: 'Asia/Shanghai' },
    })
    now = 125
    sections.collect({
      type: 'tool_result',
      toolName: 'sys_get_time',
      callId: 'call_1',
      content: '12:00',
    })
    sections.collect({ type: 'token', content: '完成' })
    now = 140
    const display = new DisplayMessageCollector({
      now: (): number => now,
      buildSections: (): JsonValue => sections.build(),
    })

    await display.onAssistantMessage(newContext(), { role: 'assistant', content: '完成' }, SIGNAL)

    assert.deepEqual(display.messages[0]?.sections, [
      {
        type: 'reason',
        items: [{ itemType: 'step', content: '先分析' }],
        timestamp: 90,
        duration: 20,
      },
      {
        type: 'tool_group',
        tools: [
          {
            callId: 'call_1',
            name: 'sys_get_time',
            params: '{"timezone":"Asia/Shanghai"}',
            status: 'success',
            result: '12:00',
            duration: 15,
          },
        ],
        timestamp: 110,
        duration: 15,
      },
      { type: 'content', content: '完成', timestamp: 125, duration: 15 },
    ])
  })
})

function stream(chunks: readonly LlmChunk[]): AsyncIterable<LlmChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
      let index = 0
      return {
        next(): Promise<IteratorResult<LlmChunk>> {
          const chunk = chunks[index]
          index += 1
          return Promise.resolve(
            chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk }
          )
        },
      }
    },
  }
}

function interruptingTool(name: string): ToolSchema {
  return {
    type: 'function',
    function: { name, description: '', parameters: {} },
    interrupting: true,
  }
}

function newContext(): RuntimeContext {
  return new RuntimeContext({
    sessionId: 'session-1',
    checkpointId: 'session-1',
    userId: 'user-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    checkpointRevision: 0n,
    fencingToken: 0n,
    messages: [{ role: 'user', content: '你好' }],
    llmContext: [],
  })
}

function hasPendingCard(message: { readonly sections?: unknown }): boolean {
  if (!Array.isArray(message.sections)) return false
  return message.sections.some(
    (section): boolean =>
      isRecord(section) &&
      section['type'] === 'card' &&
      isRecord(section['card']) &&
      section['card']['status'] === 'pending'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
