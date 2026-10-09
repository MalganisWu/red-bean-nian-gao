import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { JsonObject, JsonValue } from 'red-bean-qing-tuan/pipeline'

import type {
  DisplayMessage,
  SectionItem,
} from '../../../../src/modules/agent/presentation/model/display-message.js'
import {
  SUB_EXEC_DISPLAY_METADATA_KEY,
  SectionBuildNode,
  SubExecDisplayRegistry,
  embedSubAgentSections,
  subAgentDisplayReadyEvent,
  type ProductPipelineContext,
  type SectionEventCollector,
} from '../../../../src/modules/agent/subagent/service/subagent-display.js'

void describe('sub Agent display registry', () => {
  void it('stores data and returns a safe snapshot', () => {
    const registry = new SubExecDisplayRegistry()
    const data = { agent_id: 'a1', execution_id: 'SAEX_1' }
    const expected = { ...data }
    registry.set('call_1', data)

    const snapshot = registry.data()
    assert.deepEqual(snapshot.get('call_1'), expected)
    assert.equal(new SubExecDisplayRegistry().data().size, 0)

    const stored = snapshot.get('call_1')
    if (stored !== undefined && isJsonObject(stored)) {
      Object.assign(stored, { agent_id: 'snapshot-mutated' })
    }
    assert.deepEqual(registry.data().get('call_1'), expected)

    data.agent_id = 'mutated'
    assert.deepEqual(registry.data().get('call_1'), expected)
  })

  void it('keeps independent snapshots during concurrent asynchronous callers', async () => {
    const registry = new SubExecDisplayRegistry()
    await Promise.all(
      Array.from({ length: 40 }, (_value, index): Promise<void> =>
        Promise.resolve().then((): void => {
          const callId = `call_${String.fromCodePoint(97 + (index % 5))}`
          registry.set(callId, { index })
          const snapshot = registry.data()
          assert.ok(snapshot.has(callId))
        })
      )
    )
    assert.equal(registry.data().size, 5)
  })
})

void describe('sub Agent display event capture', () => {
  void it('captures internal display events without forwarding them to transport', async () => {
    const registry = new SubExecDisplayRegistry()
    const forwarded: unknown[] = []
    const collected: unknown[] = []
    const collector: SectionEventCollector = {
      collect(event: unknown): void {
        collected.push(event)
      },
    }
    const context: ProductPipelineContext = {
      metadata: new Map([[SUB_EXEC_DISPLAY_METADATA_KEY, registry]]),
      eventSink(event: unknown): void {
        forwarded.push(event)
      },
    }
    const node = new SectionBuildNode((): SectionEventCollector => collector)

    await node.execute(context, new AbortController().signal)
    const ready = subAgentDisplayReadyEvent({ execution_id: 'SAEX_1' })
    context.eventSink?.({ parentCallId: 'call_1', event: ready })

    assert.deepEqual(registry.data().get('call_1'), { execution_id: 'SAEX_1' })
    assert.deepEqual(forwarded, [])
    assert.deepEqual(collected, [])
  })
})

void describe('embedSubAgentSections', () => {
  void it('inserts a sub Agent section after its tool group and retains parent_call_id', () => {
    const messages = assistantMessages([
      toolGroup([{ callId: 'call_1', name: '子助手', status: 'success' }]),
      { type: 'content', content: '最终回复', timestamp: 0 },
    ])
    const data = new Map([
      [
        'call_1',
        {
          agent_id: 'a1',
          agent_name: '子助手',
          execution_id: 'SAEX_1',
          sections: [{ type: 'content', content: '子过程' }],
        },
      ],
    ])

    const sections = assistantSections(embedSubAgentSections(messages, data))
    assert.equal(sections.length, 3)
    assert.deepEqual(
      sections.map((section): string => section.type),
      ['tool_group', 'sub_agent', 'content']
    )
    assert.deepEqual(sections[1]?.items, {
      agent_id: 'a1',
      agent_name: '子助手',
      execution_id: 'SAEX_1',
      parent_call_id: 'call_1',
      sections: [{ type: 'content', content: '子过程' }],
    })
  })

  void it('leaves messages untouched when no delegation call matches', () => {
    const original = assistantMessages([
      toolGroup([{ callId: 'call_9', name: 'sys_fetch_url', status: 'success' }]),
    ])
    const result = embedSubAgentSections(original, new Map([['call_1', {}]]))

    assert.deepEqual(result, original)
  })

  void it('keeps tool order when a group contains multiple delegations', () => {
    const messages = assistantMessages([
      toolGroup([
        { callId: 'call_a', name: '子A', status: 'success' },
        { callId: 'call_b', name: '子B', status: 'success' },
      ]),
    ])
    const data = new Map([
      ['call_a', { agent_name: 'A' }],
      ['call_b', { agent_name: 'B' }],
    ])

    const sections = assistantSections(embedSubAgentSections(messages, data))
    assert.deepEqual(
      sections.map((section): string => section.type),
      ['tool_group', 'sub_agent', 'sub_agent']
    )
    assert.deepEqual(sections[1]?.items, { agent_name: 'A', parent_call_id: 'call_a' })
    assert.deepEqual(sections[2]?.items, { agent_name: 'B', parent_call_id: 'call_b' })
  })

  void it('skips malformed section data without replacing it', () => {
    const original: readonly DisplayMessage[] = [
      { role: 'assistant', sections: 'not-json', timestamp: 1 },
    ]

    assert.deepEqual(embedSubAgentSections(original, new Map([['call_1', {}]])), original)
  })
})

function assistantMessages(sections: JsonValue): readonly DisplayMessage[] {
  return [{ role: 'assistant', sections, timestamp: 1 }]
}

function toolGroup(
  tools: { readonly callId: string; readonly name: string; readonly status: string }[]
): JsonValue {
  return { type: 'tool_group', tools, timestamp: 0 }
}

function assistantSections(messages: readonly DisplayMessage[]): readonly SectionItem[] {
  const first = messages[0]
  assert.ok(first !== undefined)
  assert.ok(Array.isArray(first.sections))
  return first.sections.map(parseSectionItem)
}

function parseSectionItem(value: JsonValue): SectionItem {
  if (!isJsonObject(value) || typeof value['type'] !== 'string') {
    throw new Error('test fixture must be a section item')
  }
  const content = value['content']
  const items = value['items']
  const tools = value['tools']
  return {
    type: value['type'],
    timestamp: numberField(value, 'timestamp'),
    ...(typeof content === 'string' ? { content } : {}),
    ...(items !== undefined ? { items } : {}),
    ...(tools !== undefined ? { tools } : {}),
  }
}

function numberField(value: JsonObject, name: string): number {
  const candidate = value[name]
  return typeof candidate === 'number' ? candidate : 0
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
