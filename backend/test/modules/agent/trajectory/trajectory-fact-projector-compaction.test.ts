import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RUN_FACT_SCHEMA_VERSION } from '../../../../src/modules/agent/run-facts/model/run-fact.js'

import { projectFactsTrajectory } from '../../../../src/modules/agent/trajectory/service/trajectory-fact-projector.js'

import { STARTED_AT, assistantFact, run, userFact } from './trajectory-fact-test-support.js'

void describe('事实日志轨迹投影（压缩）', () => {
  void it('surfaces the latest session-level compaction with turn placement and status', () => {
    const compactionAt = (at: number, status: 'success' | 'failed' | 'interrupted') => ({
      type: 'compaction' as const,
      at,
      trigger: 'auto' as const,
      beforeTokens: 100_000,
      afterTokens: 8_100,
      messages: 42,
      durationMs: 4_300,
      status,
      schemaVersion: RUN_FACT_SCHEMA_VERSION,
    })
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        facts: [
          userFact('第一轮', STARTED_AT + 10),
          compactionAt(STARTED_AT + 500, 'success'),
          assistantFact({
            at: STARTED_AT + 600,
            content: '第一步',
            promptTokens: 10,
            completionTokens: 2,
          }),
        ],
      }),
      run({
        runId: 'RUN_2',
        runIndex: 1,
        startedAt: STARTED_AT + 8_000,
        facts: [userFact('第二轮', STARTED_AT + 8_010), compactionAt(STARTED_AT + 9_000, 'failed')],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      processStartedAt: STARTED_AT,
      subExecutions: [],
      messages: [],
    })

    // DTO 单槽：多次压缩取最近一次（failed），afterTurn 指向压缩发生时所在轮次。
    assert.deepEqual(
      view.compaction && {
        afterTurn: view.compaction.afterTurn,
        at: view.compaction.at,
        beforeTokens: view.compaction.beforeTokens,
        afterTokens: view.compaction.afterTokens,
        messages: view.compaction.messages,
        durationMs: view.compaction.durationMs,
        status: view.compaction.status,
      },
      {
        afterTurn: 2,
        at: STARTED_AT + 9_000,
        beforeTokens: 100_000,
        afterTokens: 8_100,
        messages: 42,
        durationMs: 4_300,
        status: 'failed',
      }
    )
    assert.ok(view.compaction?.id !== undefined)
    assert.equal(typeof view.compaction.seq, 'number')
  })

  void it('keeps compaction null for runs without compaction facts', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        facts: [userFact('普通轮', STARTED_AT + 10)],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      processStartedAt: STARTED_AT,
      subExecutions: [],
      messages: [],
    })

    assert.equal(view.compaction, null)
  })

  void it('不为仅有压缩事实的 run 造出空轮次', () => {
    const runs = [
      run({
        runId: 'RUN_1',
        runIndex: 0,
        facts: [
          {
            type: 'compaction',
            at: STARTED_AT + 10,
            trigger: 'auto',
            beforeTokens: 100_000,
            afterTokens: 8_100,
            messages: 42,
            durationMs: 4_300,
            status: 'success',
            schemaVersion: RUN_FACT_SCHEMA_VERSION,
          },
        ],
      }),
    ]

    const view = projectFactsTrajectory({
      sessionId: 'SESS_1',
      runs,
      subExecutions: [],
      messages: [],
      processStartedAt: STARTED_AT,
    })

    // 压缩是会话级事实，不产生轮次记录：不得因此新建一个永不终结的空轮次。
    assert.equal(view.turns.length, 0)
    assert.equal(view.compaction?.afterTurn, 0)
  })
})
