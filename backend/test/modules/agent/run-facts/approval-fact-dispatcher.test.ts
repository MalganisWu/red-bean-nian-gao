import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ApprovalFactToolDispatcher } from '../../../../src/modules/agent/run-facts/service/approval-fact-dispatcher.js'
import { RunFactRecorder } from '../../../../src/modules/agent/run-facts/service/run-fact-recorder.js'
import type {
  SessionRunRecord,
  StartSessionRunCommand,
} from '../../../../src/modules/agent/run-facts/model/session-run.js'
import { SESSION_RUN_STATUSES } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import type { RunFact } from '../../../../src/modules/agent/run-facts/model/run-fact.js'
import type { RunFactRepository } from '../../../../src/modules/agent/run-facts/port/run-fact-repository.port.js'
import type {
  AgentToolCallContext,
  AgentToolDispatcher,
  AgentToolResult,
} from '../../../../src/modules/agent/execution/model/agent-execution-contract.js'
import type { AgentToolCall } from '../../../../src/modules/agent/model/agent-message.js'

/**
 * 审批挂起事实写入装饰器：interrupting 工具在 Runtime 里不发 tool_start / tool_result，
 * 只能由宿主在工具返回 interrupt 信号时自己落一条。这里锁住三个行为：
 * 返回信号才写、参数解析失败不影响调用、正常返回不写。
 */

const SIGNAL = new AbortController().signal
const STARTED_AT = 1_000

const START: StartSessionRunCommand = {
  runId: 'RUN_1',
  sessionId: 'SESSION_1',
  userId: 'USER_1',
  provider: 'openai',
  model: 'deepseek-chat',
  contextWindow: 131_072,
  startedAt: STARTED_AT,
}

/** 只收集 appendFact 的极简仓储：本用例只关心写了什么事实。 */
class CollectingRepository implements RunFactRepository {
  public readonly appended: Array<{ readonly runId: string; readonly fact: RunFact }> = []
  public create(run: StartSessionRunCommand): Promise<SessionRunRecord> {
    return Promise.resolve({
      ...run,
      runIndex: 0,
      status: SESSION_RUN_STATUSES.RUNNING,
      endedAt: null,
      facts: [],
      schemaVersion: 1,
    })
  }
  public appendFact(runId: string, fact: RunFact): Promise<void> {
    this.appended.push({ runId, fact })
    return Promise.resolve()
  }
  public finalize(): Promise<void> {
    return Promise.resolve()
  }
  public listBySession(): Promise<readonly SessionRunRecord[]> {
    return Promise.resolve([])
  }
}

/** 返回固定结果的 dispatcher；`signal` 决定它是否表现为「挂起」。 */
class FixedDispatcher implements AgentToolDispatcher {
  readonly #result: AgentToolResult
  public constructor(result: AgentToolResult) {
    this.#result = result
  }
  public dispatch(): Promise<AgentToolResult> {
    return Promise.resolve(this.#result)
  }
}

function toolCall(argumentsJson: string): AgentToolCall {
  return {
    id: 'call_9',
    type: 'function',
    function: { name: 'ask_user', arguments: argumentsJson },
  }
}

function context(): AgentToolCallContext {
  return {
    threadId: 'S1',
    userId: 'U1',
    requestId: 'R1',
    traceId: 'T1',
    callId: 'call_9',
    checkpointRevision: 0n,
    fencingToken: 0n,
  }
}

async function buildRecorder(repository: CollectingRepository): Promise<RunFactRecorder> {
  const recorder = new RunFactRecorder({
    run: START,
    signal: new AbortController().signal,
    repository,
    now: (): number => STARTED_AT,
  })
  await recorder.start(SIGNAL)
  return recorder
}

void describe('ApprovalFactToolDispatcher', () => {
  void it('工具返回 interrupt 信号时写一条挂起事实，并解析出参数', async () => {
    const repository = new CollectingRepository()
    const recorder = await buildRecorder(repository)
    const dispatcher = new ApprovalFactToolDispatcher(
      new FixedDispatcher({ content: '', signal: { kind: 'interrupt', payload: {} } }),
      recorder,
      /* 装饰器有自己的时钟：startedAt 记的是**工具开始时刻**，不是事实落库时刻 */
      (): number => STARTED_AT
    )

    const args = JSON.stringify({
      questions: [{ id: 'q1', text: '确认分享给张三？', options: ['同意'], select: 'single' }],
    })
    await dispatcher.dispatch(toolCall(args), context(), SIGNAL)

    const fact = repository.appended.map((entry) => entry.fact).find((fact) => fact.type === 'tool')
    assert.ok(fact !== undefined && fact.type === 'tool')
    assert.equal(fact.callId, 'call_9')
    assert.equal(fact.name, 'ask_user')
    assert.equal(fact.status, 'interrupt')
    assert.equal(fact.startedAt, STARTED_AT)
    assert.deepEqual(fact.params, {
      questions: [{ id: 'q1', text: '确认分享给张三？', options: ['同意'], select: 'single' }],
    })
  })

  void it('正常返回不写事实（成功路径已由 tool_result 事件承担）', async () => {
    const repository = new CollectingRepository()
    const recorder = await buildRecorder(repository)
    const dispatcher = new ApprovalFactToolDispatcher(
      new FixedDispatcher({ content: '5 条结果' }),
      recorder,
      (): number => STARTED_AT
    )

    const result = await dispatcher.dispatch(toolCall('{}'), context(), SIGNAL)

    assert.equal(result.content, '5 条结果')
    assert.equal(repository.appended.length, 0)
  })

  void it('参数不是合法 JSON 时按「无参数」处理，不影响工具调用本身', async () => {
    const repository = new CollectingRepository()
    const recorder = await buildRecorder(repository)
    const dispatcher = new ApprovalFactToolDispatcher(
      new FixedDispatcher({ content: '', signal: { kind: 'interrupt', payload: {} } }),
      recorder,
      /* 装饰器有自己的时钟：startedAt 记的是**工具开始时刻**，不是事实落库时刻 */
      (): number => STARTED_AT
    )

    await dispatcher.dispatch(toolCall('not-json'), context(), SIGNAL)

    const fact = repository.appended.map((entry) => entry.fact).find((fact) => fact.type === 'tool')
    assert.ok(fact !== undefined && fact.type === 'tool')
    assert.equal(fact.params, null)
    // 关键：调用本身照常完成，参数格式问题不得升级为失败
    assert.equal(fact.status, 'interrupt')
  })
})
