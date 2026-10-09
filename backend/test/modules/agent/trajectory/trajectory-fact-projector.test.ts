import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SESSION_RUN_STATUSES } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import type { SessionRunRecord } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import type { DisplayMessage } from '../../../../src/modules/agent/presentation/model/display-message.js'

import { projectFactsTrajectory } from '../../../../src/modules/agent/trajectory/service/trajectory-fact-projector.js'

import {
  STARTED_AT,
  assistantFact,
  run,
  subExecution,
  toolFact,
  userFact,
} from './trajectory-fact-test-support.js'

void describe('事实日志轨迹投影', () => {
  void it('projects turns, step tokens, request attempts and terminal state from run facts', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        facts: [
          userFact('开始', STARTED_AT + 10),
          assistantFact({
            at: STARTED_AT + 120,
            durationMs: 200,
            promptTokens: 100,
            completionTokens: 20,
            cacheReadTokens: 40,
            attempts: [
              {
                attempt: 1,
                startedAt: STARTED_AT + 20,
                endedAt: STARTED_AT + 60,
                usage: null,
                error: 'LLM stream failed: boom',
              },
              {
                attempt: 2,
                startedAt: STARTED_AT + 80,
                endedAt: STARTED_AT + 120,
                usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 40 },
              },
            ],
            thinking: '先想一下',
            content: '给你答案',
          }),
          toolFact({
            callId: 'call_1',
            name: 'sys_search',
            startedAt: STARTED_AT + 300,
            result: '3 条',
          }),
        ],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      processStartedAt: STARTED_AT,
      subExecutions: [],
      messages: [{ role: 'user', content: '开始', timestamp: STARTED_AT + 10 }],
    })

    assert.equal(view.turns.length, 1)
    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    // token / 终态维度全部来自事实日志，不再是 G0 的 null。
    assert.equal(turn.tokens, 120)
    assert.deepEqual(turn.endState, { state: 'completed', at: STARTED_AT + 500 })

    const step = turn.records.find((record): boolean => record.kind === 'call')
    assert.ok(step !== undefined)
    assert.deepEqual(step.tokens, { input: 100, output: 20, cache: 40 })
    assert.equal(step.reply, '给你答案')
    assert.equal(step.thinking, '先想一下')

    const request = step.attempts?.[1]
    assert.ok(request !== undefined)
    assert.equal(request.attempt, '2')
    assert.equal(request.status, 'success')
    assert.deepEqual(request.tokens, { input: 100, output: 20, cache: 40 })
    const failedRequest = step.attempts?.[0]
    assert.ok(failedRequest !== undefined)
    assert.equal(failedRequest.status, 'error')
    assert.equal(failedRequest.tokens, null)

    assert.equal(view.totalTokens, 120)
    assert.deepEqual(view.sessionEnd, { state: 'completed', at: STARTED_AT + 500 })
  })

  void it('joins sub agent executions onto delegating tool facts', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        facts: [
          userFact('委派任务', STARTED_AT + 10),
          assistantFact({
            at: STARTED_AT + 100,
            content: '',
            promptTokens: 50,
            completionTokens: 10,
          }),
          toolFact({
            callId: 'call_sub',
            name: '检索员',
            startedAt: STARTED_AT + 200,
            result: '完成',
          }),
        ],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      processStartedAt: STARTED_AT,
      subExecutions: [subExecution({ parentCallId: 'call_sub', tokensUsed: 77 })],
      messages: [{ role: 'user', content: '委派任务', timestamp: STARTED_AT + 10 }],
    })

    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    const subRecord = turn.records.find((record): boolean => record.kind === 'subagent')
    assert.ok(subRecord !== undefined)
    assert.equal(subRecord.name, '检索员')
    assert.equal(subRecord.totalTokens, 77)
    assert.equal(subRecord.durationMs, 320)
    // 本轮 token 合计含子 Agent。
    assert.equal(turn.tokens, 60 + 77)
    assert.equal(view.subAgentTokens, 77)
  })

  void it('keeps display-only turns that predate the first run as the upgrade-path fallback', () => {
    const runs = [
      run({
        runId: 'RUN_2',
        runIndex: 0,
        startedAt: STARTED_AT + 10_000,
        facts: [userFact('第二轮', STARTED_AT + 10_010)],
      }),
    ]
    const messages: readonly DisplayMessage[] = [
      { role: 'user', content: '第一轮（G1 之前）', timestamp: STARTED_AT },
      {
        role: 'assistant',
        content: '旧回复',
        sections: [{ type: 'content', content: '旧回复', timestamp: STARTED_AT + 100 }],
        timestamp: STARTED_AT + 100,
      },
      { role: 'user', content: '第二轮', timestamp: STARTED_AT + 10_010 },
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      processStartedAt: STARTED_AT,
      subExecutions: [],
      messages,
    })

    assert.equal(view.turns.length, 2)
    const legacyTurn = view.turns[0]
    assert.ok(legacyTurn !== undefined)
    assert.equal(legacyTurn.tokens, null)
    assert.ok(legacyTurn.records.some((record): boolean => record.summary === '旧回复'))
    const factsTurn = view.turns[1]
    assert.ok(factsTurn !== undefined)
    assert.ok(factsTurn.records.some((record): boolean => record.kind === 'user'))
  })

  void it('maps failed and cancelled run terminal states onto the turn end marker', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        status: SESSION_RUN_STATUSES.CANCELLED,
        facts: [userFact('问一半', STARTED_AT + 10)],
      }),
      run({
        runId: 'RUN_2',
        runIndex: 1,
        status: SESSION_RUN_STATUSES.FAILED,
        error: 'provider down',
        startedAt: STARTED_AT + 1_000,
        facts: [userFact('再来', STARTED_AT + 1_010)],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      processStartedAt: STARTED_AT,
      subExecutions: [],
      messages: [],
    })

    const first = view.turns[0]
    assert.ok(first !== undefined)
    assert.deepEqual(first.endState, { state: 'cancelled', at: STARTED_AT + 500 })
    const second = view.turns[1]
    assert.ok(second !== undefined)
    assert.deepEqual(second.endState, {
      state: 'failed',
      at: STARTED_AT + 1_500,
      note: 'provider down',
    })
    assert.deepEqual(view.sessionEnd, {
      state: 'failed',
      at: STARTED_AT + 1_500,
      note: 'provider down',
    })
  })
})

void describe('审批调用的跨 run 生命周期重建', () => {
  /* 审批在存储层是同一 callId 的两条 append-only 记录：挂起落在 run N、闭合落在 run N+1
     （回答审批是一次新请求 → 新 runId）。投影必须重建为**一行**，否则一次审批看起来跑了两遍。 */
  const PENDING_AT = STARTED_AT + 200
  const CLOSED_AT = STARTED_AT + 192_200 // 等待 3 分 12 秒

  function approvalRuns(): readonly SessionRunRecord[] {
    return [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        status: SESSION_RUN_STATUSES.INTERRUPTED,
        facts: [
          userFact('把刚才那份文档分享给张三', STARTED_AT + 10),
          assistantFact({ at: STARTED_AT + 100, content: '', thinking: '需要人工确认' }),
          toolFact({
            callId: 'call_9',
            name: 'ask_user',
            startedAt: PENDING_AT,
            durationMs: 0,
            status: 'interrupt',
            params: {
              questions: [
                { id: 'q1', text: '确认分享给张三？', options: ['同意'], select: 'single' },
              ],
            },
          }),
        ],
      }),
      run({
        runId: 'RUN_2',
        runIndex: 1,
        status: SESSION_RUN_STATUSES.COMPLETED,
        startedAt: CLOSED_AT,
        // resume 不重新 dispatch 工具，Runtime 注入一条 tool 消息 → 宿主落一条闭合事实
        facts: [
          toolFact({
            callId: 'call_9',
            name: 'approval',
            startedAt: CLOSED_AT,
            durationMs: 0,
            result: '{"status":"answered"}',
          }),
          assistantFact({ at: CLOSED_AT + 500, content: '已分享给张三' }),
        ],
      }),
    ]
  }

  void it('挂起与闭合合并为一行，并算出等待时长', () => {
    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs: approvalRuns(),
      subExecutions: [],
      messages: [],
      processStartedAt: STARTED_AT - 1_000,
    })

    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    const approvals = turn.records.filter((r) => r.name === 'ask_user' || r.name === 'approval')
    // 关键：一次审批只有一行，聚合两条事实
    assert.equal(approvals.length, 1)
    const row = approvals[0]
    assert.ok(row !== undefined)
    // 名称/参数来自挂起记录，结果来自闭合记录
    assert.equal(row.name, 'ask_user')
    assert.equal(row.status, 'success')
    assert.equal(row.result, '{"status":"answered"}')
    // 时刻仍是调用开始（挂起时刻），不是闭合时刻
    assert.equal(row.at, PENDING_AT)
    // 等待与执行分开表达
    assert.equal(row.waitMs, CLOSED_AT - PENDING_AT)
    assert.equal(row.durationMs, 0)
    // 摘要与实时侧 card 事件同口径：首条问题文本
    assert.equal(row.summary, '确认分享给张三？')
    // 回答后的那次调用是独立一行，不得被吞掉
    assert.ok(turn.records.some((r) => r.kind === 'call' && r.reply === '已分享给张三'))
  })

  void it('只有挂起没有闭合时保持 interrupt，不虚构结果', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        status: SESSION_RUN_STATUSES.INTERRUPTED,
        facts: [
          userFact('分享文档', STARTED_AT + 10),
          toolFact({
            callId: 'call_9',
            name: 'ask_user',
            startedAt: PENDING_AT,
            durationMs: 0,
            status: 'interrupt',
          }),
        ],
      }),
    ]
    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      subExecutions: [],
      messages: [],
      processStartedAt: STARTED_AT - 1_000,
    })
    const row = view.turns[0]?.records.find((r) => r.name === 'ask_user')
    assert.ok(row !== undefined)
    assert.equal(row.status, 'interrupt')
    assert.equal(row.result, undefined)
    // 未闭合时 wire 层不填等待时长：由前端按当前时刻推算
    assert.equal(row.waitMs, undefined)
    // 轮次终态是「等待用户」的机制值，不是 crashed
    assert.equal(view.turns[0]?.endState?.state, 'interrupt')
  })
})
