import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { JsonValue, ToolCallContext } from 'red-bean-qing-tuan/pipeline'
import { MapToolDispatcher } from 'red-bean-qing-tuan/tools'

import { ASK_USER_TOOL_NAME, AskUserTool } from '../../../../src/modules/agent/tool/ask-user.js'

const CONTEXT: ToolCallContext = Object.freeze({
  threadId: 'thread-1',
  userId: 'user-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  callId: 'call-123',
  checkpointRevision: 1n,
  fencingToken: 1n,
})
const SIGNAL = new AbortController().signal

void describe('ask user tool', () => {
  void it('returns an interrupt carrying the current call ID', async () => {
    const result = await new AskUserTool().execute(
      {
        questions: [
          {
            id: 'q1',
            text: '确认删除任务？',
            options: ['确认删除', '取消'],
            select: 'single',
          },
        ],
      },
      CONTEXT,
      SIGNAL
    )
    assert.deepEqual(result.signal?.payload, {
      kind: 'ask',
      status: 'awaiting_user',
      interaction_id: 'call-123',
    })
  })

  void it('accepts the default select mode and rejects invalid questions', async () => {
    const tool = new AskUserTool()
    await tool.execute(
      { questions: [{ id: 'q1', text: '确认？', options: ['是', '否'] }] },
      CONTEXT,
      SIGNAL
    )

    const invalidValues: readonly JsonValue[] = [
      {},
      { questions: [] },
      { questions: [{ id: '', text: '确认？', options: ['是'] }] },
      { questions: [{ id: 'q1', text: '', options: ['是'] }] },
      { questions: [{ id: 'q1', text: '确认？', options: [] }] },
      {
        questions: [{ id: 'q1', text: '确认？', options: ['是'], select: 'checkbox' }],
      },
      {
        questions: [
          { id: 'q1', text: '问一', options: ['是'] },
          { id: 'q1', text: '问二', options: ['否'] },
        ],
      },
    ]
    for (const value of invalidValues) {
      await assert.rejects(tool.execute(value, CONTEXT, SIGNAL))
    }

    await assert.rejects(
      tool.execute(
        { questions: [{ id: 'q1', text: '确认？', options: ['是'] }] },
        { ...CONTEXT, callId: '' },
        SIGNAL
      ),
      /call_id/
    )
  })

  void it('works through the Runtime dispatcher and rejects invalid JSON', async () => {
    const dispatcher = new MapToolDispatcher([new AskUserTool()])
    const result = await dispatcher.dispatch(
      {
        id: 'call-999',
        type: 'function',
        function: {
          name: ASK_USER_TOOL_NAME,
          arguments: '{"questions":[{"id":"q1","text":"确认？","options":["是","否"]}]}',
        },
      },
      { ...CONTEXT, callId: 'call-999' },
      SIGNAL
    )
    assert.deepEqual(result.signal?.payload, {
      kind: 'ask',
      status: 'awaiting_user',
      interaction_id: 'call-999',
    })

    await assert.rejects(
      dispatcher.dispatch(
        {
          id: 'call-bad',
          type: 'function',
          function: { name: ASK_USER_TOOL_NAME, arguments: '{invalid' },
        },
        CONTEXT,
        SIGNAL
      ),
      /not valid JSON/
    )
  })

  void it('publishes an interrupting schema', () => {
    const tool = new AskUserTool()
    assert.equal(tool.name, 'sys_ask_user')
    assert.equal(tool.schema.interrupting, true)
    assert.equal(tool.schema.function.name, tool.name)
  })
})
