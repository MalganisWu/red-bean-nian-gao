import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { STATUS_CODES, type RuntimeEvent } from 'red-bean-qing-tuan/pipeline'
import {
  localizeRuntimeEvent,
  serializeSseEvent,
  toStreamErrorEvent as streamErrorEvent,
} from '../../../../../src/modules/agent/chat/controller/chat-event-presenter.js'
import {
  cancelRegistryKey,
  selectMessagesForTurn as normalizeChatMessages,
} from '../../../../../src/modules/agent/chat/service/default-chat-service.js'
import { AppError } from '../../../../../src/shared/http/error-mapper.js'
import {
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
} from '../../../../../src/modules/agent/session/model/session.js'

void describe('chat request and SSE parity', () => {
  void it('keeps seed messages for new sessions and only the latest user turn for existing ones', () => {
    const messages = [
      { role: 'user' as const, content: '旧问题' },
      { role: 'assistant' as const, content: '旧回答' },
      { role: 'user' as const, content: '本轮问题' },
    ]
    assert.deepEqual(normalizeChatMessages(messages), messages)
    assert.deepEqual(normalizeChatMessages(messages, 'SESSION_1'), [messages[2]])
    assert.deepEqual(
      normalizeChatMessages([{ role: 'assistant', content: '孤立回答' }], 'SESSION_1'),
      []
    )
  })

  void it('scopes cancellation keys by user', () => {
    assert.equal(cancelRegistryKey('USER_A', 'RUN_1'), 'USER_A:RUN_1')
    assert.notEqual(cancelRegistryKey('USER_A', 'RUN_1'), cancelRegistryKey('USER_B', 'RUN_1'))
  })

  void it('maps safe session and application errors without leaking unknown failures', () => {
    assert.deepEqual(
      streamErrorEvent(
        new SessionStoreError(SESSION_STORE_ERROR_CODES.NOT_FOUND, 'private detail')
      ),
      { type: 'error', code: 4004, message: '会话不存在' }
    )
    assert.deepEqual(
      streamErrorEvent(
        new SessionStoreError(SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT, 'private detail')
      ),
      { type: 'error', code: 4009, message: '交互不存在或已处理' }
    )
    assert.deepEqual(
      streamErrorEvent(new AppError({ httpStatus: 409, code: 4009, message: '自定义文案' })),
      { type: 'error', code: 4009, message: '自定义文案' }
    )
    assert.deepEqual(streamErrorEvent(new Error('secret')), {
      type: 'error',
      code: 5000,
      message: '服务器内部错误',
    })
  })

  void it('localizes structured status events including nested child events', () => {
    const cases: readonly [RuntimeEvent, string][] = [
      [{ type: 'status', code: STATUS_CODES.THINKING }, '思考中...'],
      [{ type: 'status', code: STATUS_CODES.ANALYZING_RESULTS }, '正在分析结果...'],
      [
        { type: 'status', code: STATUS_CODES.LLM_RETRY, attempt: 2, maxAttempts: 11 },
        'LLM 请求失败，正在进行第 1/10 次重试...',
      ],
      [
        { type: 'status', code: STATUS_CODES.LLM_EMPTY_RESPONSE_RETRY, attempt: 2, maxAttempts: 3 },
        'LLM 返回空响应，正在重试 (2/3)...',
      ],
    ]
    for (const [event, content] of cases) {
      const localized = localizeRuntimeEvent(event)
      assert.equal(localized.type, 'status')
      assert.ok('content' in localized)
      assert.equal(localized.content, content)
    }
    const nested = localizeRuntimeEvent({
      type: 'agent_event',
      agentId: 'child',
      agentName: '研究员',
      executionId: 'exec_1',
      parentCallId: 'call_parent',
      eventType: 'status',
      event: { type: 'status', code: STATUS_CODES.THINKING },
    })
    assert.equal(nested.type, 'agent_event')
    if (nested.type !== 'agent_event') throw new Error('expected child envelope')
    const localizedChild = localizeRuntimeEvent(nested.event)
    assert.equal(localizedChild.type, 'status')
    assert.ok('content' in localizedChild)
    assert.equal(localizedChild.content, '思考中...')
  })

  void it('serializes localized status fields to one canonical SSE frame', () => {
    const frame = serializeSseEvent({
      type: 'status',
      code: STATUS_CODES.LLM_RETRY,
      attempt: 2,
      maxAttempts: 3,
      content: 'LLM 请求失败，正在进行第 1/2 次重试...',
    })
    const lines = frame.trim().split('\n')
    assert.equal(lines[0], 'event: status')
    assert.deepEqual(JSON.parse((lines[1] ?? '').replace(/^data: /u, '')), {
      code: 'llm_retry',
      attempt: 2,
      max_attempts: 3,
      content: 'LLM 请求失败，正在进行第 1/2 次重试...',
    })
  })
})
