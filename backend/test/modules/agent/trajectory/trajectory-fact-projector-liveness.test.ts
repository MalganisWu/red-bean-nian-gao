import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SESSION_RUN_STATUSES } from '../../../../src/modules/agent/run-facts/model/session-run.js'

import { projectFactsTrajectory } from '../../../../src/modules/agent/trajectory/service/trajectory-fact-projector.js'

import { STARTED_AT, assistantFact, run, userFact } from './trajectory-fact-test-support.js'

void describe('事实日志轨迹投影（进行中与崩溃遗留 run）', () => {
  void it('keeps a run still executing as an in-progress turn without inventing an end state', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        status: SESSION_RUN_STATUSES.RUNNING,
        endedAt: null,
        facts: [
          userFact('帮我调研一下红豆年糕的做法', STARTED_AT + 10),
          assistantFact({
            at: STARTED_AT + 120,
            content: 'The user wants me to research',
            promptTokens: 12,
            completionTokens: 4,
          }),
        ],
      }),
    ]

    // 进程先于 run 启动 → 该 run 仍在本进程内执行，属于"进行中"。
    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      subExecutions: [],
      messages: [],
      processStartedAt: STARTED_AT - 1_000,
    })

    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    // 回归：运行中的 run 曾被投影成 0ms 的"已中断"，并让会话提前显示已结束。
    assert.equal(turn.endState, undefined)
    assert.equal(view.sessionEnd, null)
    // 时长退化为"已落库活动区间"的下界（用户 +10 → 末条事实 +120），不是虚构终态。
    assert.equal(turn.startedAt, STARTED_AT + 10)
    assert.equal(turn.durationMs, 110)
  })

  void it('closes a running run that started before this process as crashed', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        status: SESSION_RUN_STATUSES.RUNNING,
        endedAt: null,
        facts: [
          userFact('崩溃前的问题', STARTED_AT + 10),
          assistantFact({ at: STARTED_AT + 120, content: '半截回复' }),
        ],
      }),
    ]

    // 进程在 run 之后才启动 → 该行不可能仍在执行，是崩溃遗留。
    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      subExecutions: [],
      messages: [],
      processStartedAt: STARTED_AT + 60_000,
    })

    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    // 用 crashed 而非 interrupt：前者是进程遗留，后者是 LLM 主动发起挂起。
    assert.deepEqual(turn.endState, {
      state: 'crashed',
      at: STARTED_AT + 120,
      note: '运行进程中断',
    })
    assert.deepEqual(view.sessionEnd, {
      state: 'crashed',
      at: STARTED_AT + 120,
      note: '运行进程中断',
    })
  })

  void it('maps a suspended run to interrupt, not crashed', () => {
    /* INTERRUPTED 是 Runtime suspended 的唯一落点，语义是「LLM 发起挂起、等用户作答」。
       它与崩溃遗留只差一个字母，必须由用例锁住二者不得混用。 */
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        status: SESSION_RUN_STATUSES.INTERRUPTED,
        facts: [userFact('把文档分享给张三', STARTED_AT + 10)],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      subExecutions: [],
      messages: [],
      processStartedAt: STARTED_AT - 1_000,
    })

    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    assert.equal(turn.endState?.state, 'interrupt')
    assert.equal(view.sessionEnd?.state, 'interrupt')
  })

  void it('does not let a factless run overwrite the previous turn terminal state', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        facts: [userFact('第一轮', STARTED_AT + 10)],
      }),
      // 启动即失败、没有任何事实的 run：不属于任何轮次，也不得改写上一轮终态。
      run({
        runId: 'RUN_2',
        runIndex: 1,
        status: SESSION_RUN_STATUSES.FAILED,
        error: 'provider down',
        startedAt: STARTED_AT + 1_000,
        facts: [],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      subExecutions: [],
      messages: [],
      processStartedAt: STARTED_AT - 1_000,
    })

    assert.equal(view.turns.length, 1)
    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    assert.deepEqual(turn.endState, { state: 'completed', at: STARTED_AT + 500 })
    // 会话终态仍取最后一个 run：失败确实发生过，审计不掩盖。
    assert.deepEqual(view.sessionEnd, {
      state: 'failed',
      at: STARTED_AT + 1_500,
      note: 'provider down',
    })
  })
})
