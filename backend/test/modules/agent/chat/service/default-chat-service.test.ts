import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IdGenerator } from '../../../../../src/shared/id/id-generator.js'
import type { CancelRegistryPort } from '../../../../../src/modules/agent/cancellation/port/cancellation-registry.port.js'
import type { AgentRunRequest } from '../../../../../src/modules/agent/run/model/agent-run.js'
import type { AgentRunServicePort } from '../../../../../src/modules/agent/run/port/agent-run-service.port.js'
import { DefaultChatService } from '../../../../../src/modules/agent/chat/service/default-chat-service.js'
import {
  ManagedChatRunHandle,
  type ChatRunHandle,
} from '../../../../../src/modules/agent/chat/stream/chat-run-handle.js'

class FixedIds implements IdGenerator {
  public generate(prefix: string): string {
    return `${prefix}_1`
  }
}

class MemoryCancelRegistry implements CancelRegistryPort {
  public wrappedKey = ''
  public deregisteredKey = ''

  public wrap(parent: AbortSignal, key: string): AbortSignal {
    this.wrappedKey = key
    return parent
  }

  public cancel(): boolean {
    return true
  }

  public deregister(key: string): void {
    this.deregisteredKey = key
  }
}

class PendingRunService implements AgentRunServicePort {
  public request: AgentRunRequest | undefined
  public handle: ManagedChatRunHandle | undefined

  public start(request: AgentRunRequest, signal: AbortSignal): ChatRunHandle {
    this.request = request
    this.handle = new ManagedChatRunHandle(request.runId, request.sessionId, signal)
    return this.handle
  }
}

void describe('DefaultChatService', () => {
  void it('拥有消息选择、ID 与取消注册编排', async () => {
    const runs = new PendingRunService()
    const cancellations = new MemoryCancelRegistry()
    const service = new DefaultChatService({
      runService: runs,
      cancelRegistry: cancellations,
      idGenerator: new FixedIds(),
    })

    const run = await service.start({
      userId: 'USER_1',
      traceId: 'TRACE_1',
      signal: new AbortController().signal,
      sessionId: 'SESSION_1',
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
        { role: 'user', content: '本轮问题' },
      ],
    })

    assert.deepEqual(runs.request?.messages, [{ role: 'user', content: '本轮问题' }])
    assert.equal(runs.request?.runId, 'RUN_1')
    assert.equal(cancellations.wrappedKey, 'USER_1:RUN_1')
    runs.handle?.complete()
    await run.handle.completion
    await Promise.resolve()
    assert.equal(cancellations.deregisteredKey, 'USER_1:RUN_1')
  })

  void it('缺省 sessionId 与 agentId 时补默认值', async () => {
    const runs = new PendingRunService()
    const service = new DefaultChatService({
      runService: runs,
      cancelRegistry: new MemoryCancelRegistry(),
      idGenerator: new FixedIds(),
    })

    const run = await service.start({
      userId: 'USER_1',
      traceId: 'TRACE_1',
      signal: new AbortController().signal,
      messages: [{ role: 'user', content: 'hello' }],
    })

    // 无 sessionId 走新会话口径：种子消息整段保留，标识由 idGenerator 补齐。
    assert.equal(runs.request?.sessionId, 'SESS_1')
    assert.equal(runs.request?.agentId, 'default')
    assert.deepEqual(runs.request?.messages, [{ role: 'user', content: 'hello' }])
    runs.handle?.complete()
    await run.handle.completion
  })

  void it('answer 归一化 AnswerMarker 并走空消息的 resume 语义', async () => {
    const runs = new PendingRunService()
    const service = new DefaultChatService({
      runService: runs,
      cancelRegistry: new MemoryCancelRegistry(),
      idGenerator: new FixedIds(),
    })

    const run = await service.answer({
      userId: 'USER_1',
      traceId: 'TRACE_1',
      signal: new AbortController().signal,
      sessionId: 'SESSION_1',
      interactionId: 'CALL_1',
    })

    // 回答路径不携带新消息；answers/refused 缺省归一化为空对象与 false（不落 undefined）。
    assert.deepEqual(runs.request?.messages, [])
    assert.deepEqual(runs.request?.answer, {
      interactionId: 'CALL_1',
      answers: {},
      refused: false,
    })
    assert.equal(runs.request?.agentId, 'default')
    runs.handle?.complete()
    await run.handle.completion
  })

  void it('answer 保留显式提供的 answers 与 refused', async () => {
    const runs = new PendingRunService()
    const service = new DefaultChatService({
      runService: runs,
      cancelRegistry: new MemoryCancelRegistry(),
      idGenerator: new FixedIds(),
    })

    const run = await service.answer({
      userId: 'USER_1',
      traceId: 'TRACE_1',
      signal: new AbortController().signal,
      sessionId: 'SESSION_1',
      agentId: 'AGENT_1',
      interactionId: 'CALL_1',
      answers: { q1: 'a1' },
      refused: true,
    })

    assert.deepEqual(runs.request?.answer, {
      interactionId: 'CALL_1',
      answers: { q1: 'a1' },
      refused: true,
    })
    assert.equal(runs.request?.agentId, 'AGENT_1')
    runs.handle?.complete()
    await run.handle.completion
  })

  void it('停机取消活动运行并等待生产者完成 finalization', async () => {
    const runs = new PendingRunService()
    const service = new DefaultChatService({
      runService: runs,
      cancelRegistry: new MemoryCancelRegistry(),
      idGenerator: new FixedIds(),
    })
    const run = await service.start({
      userId: 'USER_1',
      traceId: 'TRACE_1',
      signal: new AbortController().signal,
      messages: [{ role: 'user', content: 'hello' }],
    })

    let shutdownFinished = false
    const shutdown = service.shutdown(new AbortController().signal).finally((): void => {
      shutdownFinished = true
    })
    await Promise.resolve()
    assert.equal(runs.handle?.signal.aborted, true)
    assert.equal(shutdownFinished, false)

    runs.handle?.complete()
    await shutdown
    assert.deepEqual(await run.handle.completion, {
      status: 'cancelled',
      reason: 'server_shutdown',
    })
  })
})
