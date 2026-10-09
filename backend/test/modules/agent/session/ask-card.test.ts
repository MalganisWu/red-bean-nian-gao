import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { RawMessage } from 'red-bean-qing-tuan/pipeline'

import {
  appendWithoutOverlap,
  assertAskIsLast,
  buildAnswerToolResult,
  findPendingCard,
  hasPendingCard,
  mergeContinuation,
  resolveCard,
  filterAskToolGroup,
  validateAndFix,
} from '../../../../src/modules/agent/session/service/ask-card.js'
import type { AnswerMarker } from '../../../../src/modules/agent/session/model/session.js'

void describe('ask-card pipeline helpers', () => {
  void it('removes only the interrupting ask tool and drops an empty tool group', () => {
    const onlyAsk = [
      {
        type: 'tool_group',
        timestamp: 1,
        tools: [{ call_id: 'call_ask', name: 'sys_ask_user', status: 'running' }],
      },
    ]
    assert.deepEqual(filterAskToolGroup(onlyAsk, 'call_ask'), [])

    const mixed = [
      { type: 'text', timestamp: 1, content: 'before' },
      {
        type: 'tool_group',
        timestamp: 2,
        tools: [
          { call_id: 'call_fetch', name: 'sys_fetch_url', status: 'success' },
          { call_id: 'call_ask', name: 'sys_ask_user', status: 'running' },
        ],
      },
    ]
    assert.deepEqual(filterAskToolGroup(mixed, 'call_ask'), [
      { type: 'text', timestamp: 1, content: 'before' },
      {
        type: 'tool_group',
        timestamp: 2,
        tools: [{ call_id: 'call_fetch', name: 'sys_fetch_url', status: 'success' }],
      },
    ])
  })

  void it('returns malformed section data unchanged instead of losing display history', () => {
    const malformed = { unexpected: true }
    assert.equal(filterAskToolGroup(malformed, 'call_ask'), malformed)
  })

  void it('keeps a dangling interrupt call but repairs other missing tool results', () => {
    const messages: readonly RawMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_fetch',
            type: 'function',
            function: { name: 'sys_fetch_url', arguments: '{}' },
          },
          {
            id: 'call_ask',
            type: 'function',
            function: { name: 'sys_ask_user', arguments: '{}' },
          },
        ],
      },
    ]

    assert.deepEqual(validateAndFix(messages, 'call_ask'), [
      ...messages,
      {
        role: 'tool',
        content: '{"error":"tool call interrupted, result unavailable"}',
        toolCallId: 'call_fetch',
      },
    ])
    assert.deepEqual(
      validateAndFix(messages.slice(0, 2), 'call_ask').at(-1)?.toolCallId,
      'call_fetch'
    )
    assert.deepEqual(
      validateAndFix(
        [
          messages[0] ?? { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call_ask',
                type: 'function',
                function: { name: 'sys_ask_user', arguments: '{}' },
              },
            ],
          },
        ],
        'call_ask'
      ).length,
      2
    )
  })

  void it('does not append a duplicate repair for a completed tool call', () => {
    const messages: readonly RawMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_fetch',
            type: 'function',
            function: { name: 'sys_fetch_url', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call_fetch' },
    ]
    assert.deepEqual(validateAndFix(messages), messages)
  })

  void it('finds only a valid pending card and builds answer or refusal results', () => {
    const card = {
      interaction_id: 'call_ask',
      status: 'pending',
      questions: [{ id: 'q1', text: '确认？', options: ['是', '否'] }],
    }
    const displayMessages = [
      {
        role: 'assistant',
        sections: [{ type: 'card', card, timestamp: 1 }],
        timestamp: 1,
      },
    ]
    assert.equal(hasPendingCard(displayMessages), true)
    const pending = findPendingCard(displayMessages, 'call_ask')
    assert.deepEqual(pending, {
      interactionId: 'call_ask',
      status: 'pending',
      questions: card.questions,
    })
    assert.equal(findPendingCard(displayMessages, 'missing'), undefined)
    assert.ok(pending !== undefined)

    const answered: AnswerMarker = {
      interactionId: 'call_ask',
      answers: { q1: { kind: 'option', value: '是' } },
      refused: false,
    }
    assert.deepEqual(JSON.parse(buildAnswerToolResult(pending, answered)), {
      status: 'answered',
      questions: card.questions,
      answers: answered.answers,
    })
    assert.match(buildAnswerToolResult(pending, { ...answered, refused: true }), /用户拒绝回答/u)
  })

  void it('resolves a card and inserts continuation sections immediately after it', () => {
    const displayMessages = [
      {
        role: 'assistant',
        sections: [
          { type: 'reason', items: [{ content: '提问思考' }], timestamp: 1 },
          {
            type: 'card',
            card: {
              interaction_id: 'call_ask',
              status: 'pending',
              questions: [{ id: 'q1' }],
            },
            timestamp: 2,
          },
        ],
        timestamp: 1,
      },
    ]
    const marker: AnswerMarker = {
      interactionId: 'call_ask',
      answers: { q1: { kind: 'option', value: '是' } },
      refused: false,
    }
    const resolved = resolveCard(displayMessages, marker)
    const merged = mergeContinuation(resolved, marker.interactionId, [
      {
        role: 'assistant',
        sections: [
          { type: 'reason', items: [{ content: '续跑思考' }], timestamp: 3 },
          { type: 'content', content: '好的', timestamp: 4 },
        ],
        timestamp: 3,
      },
    ])

    assert.equal(merged.length, 1)
    assert.deepEqual(
      Array.isArray(merged[0]?.sections)
        ? merged[0].sections.map((section): unknown =>
            typeof section === 'object' && section !== null && 'type' in section
              ? section['type']
              : undefined
          )
        : [],
      ['reason', 'card', 'reason', 'content']
    )
    assert.equal(findPendingCard(merged, marker.interactionId), undefined)
  })

  void it('rejects an answer when the ask call is absent or no longer last', () => {
    const askCall: RawMessage = {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: 'call_ask',
          type: 'function',
          function: { name: 'sys_ask_user', arguments: '{}' },
        },
      ],
    }
    assert.doesNotThrow(() => assertAskIsLast([askCall], 'call_ask'))
    assert.throws(() => assertAskIsLast([], 'call_ask'), /未找到/u)
    assert.throws(
      () => assertAskIsLast([askCall, { role: 'assistant', content: 'partial' }], 'call_ask'),
      /D2/u
    )
  })

  void it('appends recovery data without duplicating an already committed suffix', () => {
    const first: RawMessage = { role: 'user', content: 'one' }
    const second: RawMessage = { role: 'assistant', content: 'two' }
    const third: RawMessage = { role: 'user', content: 'three' }
    assert.deepEqual(appendWithoutOverlap([first, second], [second, third]), [first, second, third])
    assert.deepEqual(appendWithoutOverlap([first], [second]), [first, second])
  })
})
