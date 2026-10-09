import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RunFactRecorder } from '../../../../src/modules/agent/run-facts/service/run-fact-recorder.js'
import type {
  FinalizeSessionRunCommand,
  SessionRunRecord,
  StartSessionRunCommand,
} from '../../../../src/modules/agent/run-facts/model/session-run.js'
import {
  SESSION_RUN_CANCELLED_BY,
  SESSION_RUN_STATUSES,
} from '../../../../src/modules/agent/run-facts/model/session-run.js'
import {
  AGENT_STATUS_CODES,
  type AgentRuntimeEvent,
} from '../../../../src/modules/agent/run/model/agent-runtime-event.js'
import type {
  AgentModelAdapter,
  AgentModelChunk,
  AgentTokenUsage,
} from '../../../../src/modules/agent/execution/model/agent-execution-contract.js'
import type { AgentMessage } from '../../../../src/modules/agent/model/agent-message.js'
import type { RunFact } from '../../../../src/modules/agent/run-facts/model/run-fact.js'
import type { RunFactRepository } from '../../../../src/modules/agent/run-facts/port/run-fact-repository.port.js'

const SIGNAL = new AbortController().signal

const START: StartSessionRunCommand = {
  runId: 'RUN_1',
  sessionId: 'SESSION_1',
  userId: 'USER_1',
  provider: 'openai',
  model: 'deepseek-chat',
  contextWindow: 131_072,
  startedAt: 1_000,
}

class RecordingRunFactRepository implements RunFactRepository {
  public created: StartSessionRunCommand[] = []
  public appended: Array<{ readonly runId: string; readonly fact: RunFact }> = []
  public finalized: Array<{ readonly runId: string; readonly command: FinalizeSessionRunCommand }> =
    []
  public failingCreate = false

  public create(run: StartSessionRunCommand): Promise<SessionRunRecord> {
    if (this.failingCreate) return Promise.reject(new Error('db down'))
    this.created.push(run)
    return Promise.resolve({
      ...run,
      runIndex: 0,
      status: SESSION_RUN_STATUSES.RUNNING,
      endedAt: null,
      facts: [],
      schemaVersion: 1,
    })
  }

  public async appendFact(runId: string, fact: RunFact): Promise<void> {
    // 人为让出事件循环，验证写入顺序由 recorder 串行化而不是巧合。
    await Promise.resolve()
    this.appended.push({ runId, fact })
  }

  public finalize(runId: string, command: FinalizeSessionRunCommand): Promise<void> {
    this.finalized.push({ runId, command })
    return Promise.resolve()
  }

  public listBySession(): Promise<readonly SessionRunRecord[]> {
    return Promise.resolve([])
  }
}

interface RecorderHarness {
  readonly recorder: RunFactRecorder
  readonly repository: RecordingRunFactRepository
  readonly errors: Error[]
  readonly now: { value: number }
}

function harness(): RecorderHarness {
  const now = { value: 1_000 }
  const repository = new RecordingRunFactRepository()
  const errors: Error[] = []
  const recorder = new RunFactRecorder({
    run: START,
    signal: new AbortController().signal,
    repository,
    now: (): number => now.value,
    onError: (error): void => {
      errors.push(error)
    },
  })
  return { recorder, repository, errors, now }
}

function usage(
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens?: number | null
): AgentTokenUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
  }
}

function statusEvent(
  code: (typeof AGENT_STATUS_CODES)[keyof typeof AGENT_STATUS_CODES]
): AgentRuntimeEvent {
  return { type: 'status', code }
}

void describe('run fact recorder', () => {
  void it('records user/assistant/tool facts in arrival order and finalizes completed', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    h.recorder.onMessage(user('开始'))
    h.recorder.beginModelAttempt()
    h.recorder.publish({ type: 'reason', content: '思考中', step: 1, timestamp: 1_010 })
    h.recorder.publish({ type: 'token', content: '完成' })
    h.recorder.recordModelUsage(usage(3, 4))
    h.recorder.endModelAttempt()
    h.now.value = 1_120
    h.recorder.onMessage(assistant('完成'))
    h.recorder.publish({
      type: 'tool_start',
      toolName: 'sys_search',
      callId: 'call_1',
      params: { q: 'x' },
    })
    h.now.value = 1_150
    h.recorder.publish({
      type: 'tool_result',
      toolName: 'sys_search',
      callId: 'call_1',
      content: '找到 3 条',
    })
    await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 1_200 }, SIGNAL)

    assert.deepEqual(h.repository.created, [START])
    assert.deepEqual(
      h.repository.appended.map((entry): string => entry.fact.type),
      ['user', 'assistant', 'tool']
    )
    const assistantFact = h.repository.appended[1]?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.equal(assistantFact.content, '完成')
    assert.equal(assistantFact.thinking, '思考中')
    assert.equal(assistantFact.durationMs, 120)
    assert.deepEqual(assistantFact.usage, {
      promptTokens: 3,
      completionTokens: 4,
      cacheReadTokens: null,
    })
    assert.deepEqual(assistantFact.attempts, [
      {
        attempt: 1,
        startedAt: 1_000,
        endedAt: 1_000,
        usage: { promptTokens: 3, completionTokens: 4, cacheReadTokens: null },
      },
    ])
    const toolFact = h.repository.appended[2]?.fact
    assert.ok(toolFact?.type === 'tool')
    assert.equal(toolFact.callId, 'call_1')
    assert.equal(toolFact.result, '找到 3 条')
    assert.equal(toolFact.durationMs, 30)
    assert.deepEqual(h.repository.finalized, [
      { runId: 'RUN_1', command: { status: 'completed', endedAt: 1_200 } },
    ])
  })

  void it('attributes llm retries to separate attempts and keeps the successful usage', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    h.recorder.beginModelAttempt()
    h.recorder.markModelAttemptError('LLM stream failed: boom')
    h.recorder.endModelAttempt()
    h.recorder.publish(statusEvent(AGENT_STATUS_CODES.LLM_RETRY))
    h.recorder.beginModelAttempt()
    h.recorder.recordModelUsage(usage(9, 2))
    h.recorder.endModelAttempt()
    h.recorder.onMessage(assistant('重试后完成'))
    await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 2_000 }, SIGNAL)

    const assistantFact = h.repository.appended.find(
      (entry): boolean => entry.fact.type === 'assistant'
    )?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.deepEqual(
      assistantFact.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        error: attempt.error ?? undefined,
      })),
      [
        { attempt: 1, error: 'LLM stream failed: boom' },
        { attempt: 2, error: undefined },
      ]
    )
    assert.deepEqual(assistantFact.usage, {
      promptTokens: 9,
      completionTokens: 2,
      cacheReadTokens: null,
    })
  })

  void it('marks empty-response attempts failed via the llm_empty_response_retry status event', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    h.recorder.beginModelAttempt()
    h.recorder.recordModelUsage(usage(7, 0))
    h.recorder.endModelAttempt()
    h.recorder.publish(statusEvent(AGENT_STATUS_CODES.LLM_EMPTY_RESPONSE_RETRY))
    h.recorder.beginModelAttempt()
    h.recorder.recordModelUsage(usage(7, 5))
    h.recorder.endModelAttempt()
    h.recorder.onMessage(assistant('这次有内容'))
    await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 3_000 }, SIGNAL)

    const assistantFact = h.repository.appended.find(
      (entry): boolean => entry.fact.type === 'assistant'
    )?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.equal(assistantFact.attempts[0]?.error, '模型返回空响应')
    assert.deepEqual(assistantFact.attempts[0]?.usage, {
      promptTokens: 7,
      completionTokens: 0,
      cacheReadTokens: null,
    })
    assert.equal(assistantFact.attempts[1]?.error, undefined)
    assert.deepEqual(assistantFact.usage, {
      promptTokens: 7,
      completionTokens: 5,
      cacheReadTokens: null,
    })
  })

  void it('keeps provided cacheReadTokens and normalizes a missing value to null', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    h.recorder.beginModelAttempt()
    h.recorder.recordModelUsage(usage(5, 5, 4))
    h.recorder.endModelAttempt()
    h.recorder.onMessage(assistant('缓存命中'))
    await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 4_000 }, SIGNAL)

    const assistantFact = h.repository.appended.find(
      (entry): boolean => entry.fact.type === 'assistant'
    )?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.deepEqual(assistantFact.usage, {
      promptTokens: 5,
      completionTokens: 5,
      cacheReadTokens: 4,
    })
  })

  void it('flushes the in-flight step and tool on cancellation and attributes the user', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    h.recorder.beginModelAttempt()
    h.recorder.publish({ type: 'token', content: '说到一半' })
    h.recorder.publish({ type: 'tool_start', toolName: 'sys_long', callId: 'call_9', params: null })
    h.now.value = 9_000
    await h.recorder.finalize(
      {
        status: SESSION_RUN_STATUSES.CANCELLED,
        endedAt: 9_000,
        cancelledAt: 9_000,
        cancelledBy: SESSION_RUN_CANCELLED_BY.USER,
      },
      SIGNAL
    )

    assert.deepEqual(
      h.repository.appended.map((entry): string => entry.fact.type),
      ['assistant', 'tool']
    )
    const assistantFact = h.repository.appended[0]?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.equal(assistantFact.content, '说到一半')
    assert.deepEqual(assistantFact.usage, null)
    const toolFact = h.repository.appended[1]?.fact
    assert.ok(toolFact?.type === 'tool')
    /* 未闭合的工具按 incomplete 收尾，而不是写成 error：
       「被用户打断」与「工具自己报错」是两件事（审计语义）。 */
    assert.equal(toolFact.status, 'incomplete')
    assert.equal(toolFact.error, undefined)
    assert.equal(toolFact.durationMs, 8_000)
    assert.deepEqual(h.repository.finalized, [
      {
        runId: 'RUN_1',
        command: {
          status: 'cancelled',
          endedAt: 9_000,
          cancelledAt: 9_000,
          cancelledBy: SESSION_RUN_CANCELLED_BY.USER,
        },
      },
    ])
  })

  void it('keeps the run healthy when fact persistence fails and reports once', async () => {
    const h = harness()
    h.repository.failingCreate = true
    await h.recorder.start(SIGNAL)

    h.recorder.onMessage(user('开始'))
    await h.recorder.finalize(
      { status: SESSION_RUN_STATUSES.FAILED, endedAt: 5_000, error: '执行失败' },
      SIGNAL
    )

    assert.deepEqual(h.repository.appended, [])
    assert.deepEqual(h.repository.finalized, [])
    assert.equal(h.errors.length, 1)
    assert.match(h.errors[0]?.message ?? '', /db down/u)
  })

  void it('derives attempts from the observed model adapter stream', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    const inner: AgentModelAdapter = {
      streamCompletion: (): Promise<AsyncIterable<AgentModelChunk>> =>
        Promise.resolve({
          async *[Symbol.asyncIterator](): AsyncGenerator<AgentModelChunk> {
            await Promise.resolve()
            yield { content: '你好' }
            yield { content: null, usage: usage(6, 3, null) }
          },
        }),
    }
    const observed = h.recorder.observeModel(inner)
    const stream = await observed.streamCompletion(
      { messages: [], tools: [], params: {} },
      new AbortController().signal
    )
    const chunks: AgentModelChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.equal(chunks.length, 2)
    h.recorder.onMessage(assistant('你好'))
    await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 6_000 }, SIGNAL)

    const assistantFact = h.repository.appended.find(
      (entry): boolean => entry.fact.type === 'assistant'
    )?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.deepEqual(assistantFact.attempts, [
      {
        attempt: 1,
        startedAt: 1_000,
        endedAt: 1_000,
        usage: { promptTokens: 6, completionTokens: 3, cacheReadTokens: null },
      },
    ])
    assert.deepEqual(assistantFact.usage, {
      promptTokens: 6,
      completionTokens: 3,
      cacheReadTokens: null,
    })
  })
  void it('records a session-level compaction fact with the summarization attempt duration', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    // 步骤 1 正常结算。
    h.recorder.beginModelAttempt()
    h.recorder.recordModelUsage(usage(10, 5))
    h.recorder.endModelAttempt()
    h.recorder.onMessage(assistant('第一步'))
    // 压缩：摘要 LLM 调用作为 attempt 进入缓冲，随后 compaction 事件到达。
    h.now.value = 10_000
    h.recorder.beginModelAttempt()
    h.recorder.recordModelUsage(usage(90_000, 300))
    h.now.value = 11_500
    h.recorder.endModelAttempt()
    h.now.value = 11_600
    h.recorder.publish({
      type: 'compaction',
      trigger: 'auto',
      preTokens: 100_000,
      postTokens: 8_100,
      messagesSummarized: 42,
    })
    // 下一步正常结算：压缩 attempt 不得混入后续 assistant 事实。
    h.recorder.beginModelAttempt()
    h.recorder.recordModelUsage(usage(9_000, 200))
    h.recorder.endModelAttempt()
    h.recorder.onMessage(assistant('第二步'))
    await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 13_000 }, SIGNAL)

    const compactionFact = h.repository.appended.find(
      (entry): boolean => entry.fact.type === 'compaction'
    )?.fact
    assert.ok(compactionFact?.type === 'compaction')
    assert.deepEqual(
      {
        trigger: compactionFact.trigger,
        beforeTokens: compactionFact.beforeTokens,
        afterTokens: compactionFact.afterTokens,
        messages: compactionFact.messages,
        status: compactionFact.status,
      },
      {
        trigger: 'auto',
        beforeTokens: 100_000,
        afterTokens: 8_100,
        messages: 42,
        status: 'success',
      }
    )
    // 耗时取摘要 attempt 的起止（10_000 → 11_500）。
    assert.equal(compactionFact.durationMs, 1_500)

    const assistantFacts = h.repository.appended.filter(
      (entry): boolean => entry.fact.type === 'assistant'
    )
    const second = assistantFacts[1]?.fact
    assert.ok(second?.type === 'assistant')
    assert.deepEqual(second.attempts, [
      {
        attempt: 1,
        startedAt: 11_600,
        endedAt: 11_600,
        usage: { promptTokens: 9_000, completionTokens: 200, cacheReadTokens: null },
      },
    ])
    assert.deepEqual(second.usage, {
      promptTokens: 9_000,
      completionTokens: 200,
      cacheReadTokens: null,
    })
  })

  void it('records compaction without a measurable attempt as null duration', async () => {
    const h = harness()
    await h.recorder.start(SIGNAL)

    // 首轮循环顶部压缩：尚无任何 LLM 调用，耗时不可测。
    h.recorder.publish({
      type: 'compaction',
      trigger: 'manual',
      preTokens: 5_000,
      postTokens: 900,
      messagesSummarized: 7,
    })
    await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 6_000 }, SIGNAL)

    const compactionFact = h.repository.appended.find(
      (entry): boolean => entry.fact.type === 'compaction'
    )?.fact
    assert.ok(compactionFact?.type === 'compaction')
    assert.equal(compactionFact.durationMs, null)
    assert.equal(compactionFact.trigger, 'manual')
  })
})

void it('审批挂起：dispatcher 装饰器上报后落一条 interrupt 事实', async () => {
  const h = harness()
  await h.recorder.start(SIGNAL)
  h.now.value = 2_000

  h.recorder.recordApprovalPending({
    callId: 'call_9',
    name: 'ask_user',
    params: {
      questions: [
        { id: 'q1', text: '确认分享给张三？', options: ['同意', '拒绝'], select: 'single' },
      ],
    },
    startedAt: 1_900,
  })
  await h.recorder.finalize({ status: SESSION_RUN_STATUSES.INTERRUPTED, endedAt: 2_100 }, SIGNAL)

  const fact = h.repository.appended.find((entry) => entry.fact.type === 'tool')?.fact
  assert.ok(fact !== undefined && fact.type === 'tool')
  assert.equal(fact.callId, 'call_9')
  assert.equal(fact.name, 'ask_user')
  assert.equal(fact.status, 'interrupt')
  assert.equal(fact.startedAt, 1_900)
  // 挂起事实**不得**带 error：它既不是成功也不是失败
  assert.equal(fact.error, undefined)
  assert.equal(fact.result, undefined)
})

void it('审批闭合：resume 注入的 tool 消息落一条闭合事实', async () => {
  const h = harness()
  await h.recorder.start(SIGNAL)
  h.now.value = 5_000

  h.recorder.onMessage(toolMessage('call_9', '{"status":"answered"}'))
  await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 5_100 }, SIGNAL)

  const fact = h.repository.appended.find((entry) => entry.fact.type === 'tool')?.fact
  assert.ok(fact !== undefined && fact.type === 'tool')
  assert.equal(fact.callId, 'call_9')
  // 名称/参数由挂起事实在投影期提供，这里只是占位（沿用展示投影的 approval 口径）
  assert.equal(fact.name, 'approval')
  assert.equal(fact.result, '{"status":"answered"}')
  assert.equal(fact.status, undefined)
})

void it('普通工具的 tool 消息不得重复落事实（它已由 tool_result 事件写过）', async () => {
  const h = harness()
  await h.recorder.start(SIGNAL)

  h.recorder.publish({ type: 'tool_start', toolName: 'web_search', callId: 'call_1', params: null })
  h.recorder.publish({
    type: 'tool_result',
    toolName: 'web_search',
    callId: 'call_1',
    content: '5 条结果',
  })
  // 同一次结果的另一个通道：Runtime 提交 tool 消息
  h.recorder.onMessage(toolMessage('call_1', '5 条结果'))
  await h.recorder.finalize({ status: SESSION_RUN_STATUSES.COMPLETED, endedAt: 1_100 }, SIGNAL)

  const toolFacts = h.repository.appended.filter((entry) => entry.fact.type === 'tool')
  assert.equal(toolFacts.length, 1)
})

void it('运行终态时未闭合的工具记 incomplete，而不是写成 error', async () => {
  const h = harness()
  await h.recorder.start(SIGNAL)

  h.recorder.publish({ type: 'tool_start', toolName: 'web_search', callId: 'call_1', params: null })
  h.now.value = 3_000
  await h.recorder.finalize({ status: SESSION_RUN_STATUSES.CANCELLED, endedAt: 3_000 }, SIGNAL)

  const fact = h.repository.appended.find((entry) => entry.fact.type === 'tool')?.fact
  assert.ok(fact !== undefined && fact.type === 'tool')
  // 「被用户打断」不是「工具失败」：轨迹是审计视图，两者必须分开
  assert.equal(fact.status, 'incomplete')
  assert.equal(fact.error, undefined)
})

function user(content: string): AgentMessage {
  return { role: 'user', content }
}

function assistant(content: string): AgentMessage {
  return { role: 'assistant', content }
}

/** Runtime 在 resume 时注入的审批闭合消息：只有 callId 与内容，没有工具名与参数。 */
function toolMessage(toolCallId: string, content: string): AgentMessage {
  return { role: 'tool', content, toolCallId }
}
