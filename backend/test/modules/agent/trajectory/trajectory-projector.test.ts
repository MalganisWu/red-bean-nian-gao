import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { projectTrajectory } from '../../../../src/modules/agent/trajectory/service/trajectory-projector.js'
import type { DisplayMessage } from '../../../../src/modules/agent/presentation/model/display-message.js'
import type { SubExecutionRecord } from '../../../../src/modules/agent/subagent/model/sub-execution.js'

/* 真实持久化形状的 display_messages fixtures（sections 为 z.json 宽松载荷） */

const T1 = 1757570531000 // 14:02:11
const sec = (ms: number) => ms * 1000

function userMsg(content: string, timestamp: number): DisplayMessage {
  return { role: 'user', content, timestamp }
}

function assistantMsg(
  sections: DisplayMessage['sections'],
  timestamp: number,
  runStartedAt?: number
): DisplayMessage {
  return {
    role: 'assistant',
    ...(sections === undefined ? {} : { sections }),
    timestamp,
    ...(runStartedAt === undefined ? {} : { meta: { runStartedAt } }),
  }
}

void describe('会话轨迹投影（display_messages + sub_agent_executions → 轮次化记录）', () => {
  void it('把一轮的用户、步骤、工具投影为有序记录并推导轮次边界与合计', () => {
    const messages: DisplayMessage[] = [
      userMsg('帮我调研红豆年糕', T1),
      assistantMsg(
        [
          {
            type: 'reason',
            items: [{ itemType: 'step', content: '先搜资料' }],
            timestamp: T1 + sec(1),
            duration: 2000,
          },
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'c1',
                name: 'web_search',
                status: 'success',
                params: '{"query":"红豆年糕"}',
                result: '5 条结果',
                duration: 1800,
              },
            ],
            timestamp: T1 + sec(3),
            duration: 1900,
          },
          { type: 'content', content: '已整理好。', timestamp: T1 + sec(5), duration: 1500 },
        ],
        T1 + sec(8),
        T1
      ),
    ]

    const view = projectTrajectory({ sessionId: 's-1', messages, subExecutions: [] })

    assert.equal(view.turns.length, 1)
    const turn = view.turns[0]
    assert.ok(turn !== undefined)
    assert.equal(turn.turn, 1)
    assert.equal(turn.startedAt, T1)
    // 记录顺序：用户 → 步骤（思考） → 工具 → 步骤（回复并入）
    const kinds = turn.records.map((r) => r.kind)
    assert.deepEqual(kinds, ['user', 'call', 'tool', 'call'])
    // 序号全局递增
    assert.deepEqual(
      turn.records.map((r) => r.seq),
      [1, 2, 3, 4]
    )
    // 用户行内容
    assert.equal(turn.records[0]?.summary, '帮我调研红豆年糕')
    // 调用行：思考与回复（不再有轮次内步骤序号——行序即顺序）
    assert.equal(turn.records[1]?.kind, 'call')
    assert.equal(turn.records[1]?.thinking, '先搜资料')
    assert.equal(turn.records[3]?.kind, 'call')
    assert.equal(turn.records[3]?.reply, '已整理好。')
    // 工具行
    const tool = turn.records[2]
    assert.equal(tool?.name, 'web_search')
    assert.equal(tool?.status, 'success')
    assert.equal(tool?.durationMs, 1800)
    assert.equal(tool?.result, '5 条结果')
    // G0 空值语义：调用 token 未采集、无尝试明细
    assert.equal(turn.records[1]?.tokens, null)
    assert.deepEqual(turn.records[1]?.attempts, [])
    // 终态推导：有回复 → completed
    assert.equal(turn.endState?.state, 'completed')
    // 主会话 token 未采集；子 Agent 合计为 0
    assert.equal(view.totalTokens, null)
    assert.equal(view.subAgentTokens, 0)
    // 轮次耗时 = 首轮开始到最后一条段结束
    assert.ok(turn.durationMs > 0)
    assert.ok(view.spanMs >= turn.durationMs)
  })

  void it('按 parent_call_id 把子 Agent 执行记录并入 sub_agent 记录', () => {
    const messages: DisplayMessage[] = [
      userMsg('建个定时任务', T1),
      assistantMsg(
        [
          {
            type: 'tool_group',
            tools: [{ callId: 'call-9', name: 'delegate', status: 'success', duration: 18600 }],
            timestamp: T1 + sec(1),
            duration: 18700,
          },
          {
            type: 'sub_agent',
            items: {
              agent_id: 'agent-task',
              agent_name: '定时任务配置助手',
              execution_id: 'SAEX_1',
              parent_call_id: 'call-9',
              status: 'completed',
              result_summary: '任务已创建',
              sections: [],
            },
            timestamp: T1 + sec(2),
          },
        ],
        T1 + sec(20),
        T1
      ),
    ]
    const subExecutions = [
      {
        executionId: 'SAEX_1',
        parentCallId: 'call-9',
        agentName: '定时任务配置助手',
        modelName: 'deepseek-chat',
        tokensUsed: 12430,
        elapsedMilliseconds: 18600,
        status: 'completed',
        resultSummary: '任务已创建',
        display: [],
        recoveryMessages: [],
        userMessage: '建个定时任务',
        sessionId: 's-1',
        requestId: 'req-1',
        agentId: 'agent-task',
        userId: 'u-1',
        createdAt: new Date(T1),
        updatedAt: new Date(T1 + sec(20)),
        revision: 1n,
      } satisfies SubExecutionRecord,
    ]

    const view = projectTrajectory({ sessionId: 's-1', messages, subExecutions })
    const sub = view.turns[0]?.records.find((r) => r.kind === 'subagent')
    assert.ok(sub !== undefined)
    assert.equal(sub?.name, '定时任务配置助手')
    assert.equal(sub?.model, 'deepseek-chat')
    assert.equal(sub?.totalTokens, 12430)
    assert.equal(sub?.durationMs, 18600)
    assert.equal(sub?.result, '任务已创建')
    assert.equal(view.subAgentTokens, 12430)
  })

  void it('多轮边界：每条用户消息开新轮，间隔产生可推导的空档由层间呈现', () => {
    const messages: DisplayMessage[] = [
      userMsg('第一问', T1),
      assistantMsg(
        [{ type: 'content', content: '答一', timestamp: T1 + sec(3), duration: 500 }],
        T1 + sec(3),
        T1
      ),
      userMsg('第二问', T1 + sec(200)),
      assistantMsg(
        [{ type: 'content', content: '答二', timestamp: T1 + sec(203), duration: 500 }],
        T1 + sec(203),
        T1 + sec(200)
      ),
    ]
    const view = projectTrajectory({ sessionId: 's-1', messages, subExecutions: [] })
    assert.equal(view.turns.length, 2)
    assert.equal(view.turns[1]?.turn, 2)
    assert.equal(view.turns[1]?.startedAt, T1 + sec(200))
    // 每轮序号继续递增（全局稳定）
    const allSeq = view.turns.flatMap((t) => t.records.map((r) => r.seq))
    assert.deepEqual(
      allSeq,
      [...allSeq].sort((a, b) => a - b)
    )
  })

  void it('无 sections 的旧格式消息只剩顶层 content 投影', () => {
    const messages: DisplayMessage[] = [
      userMsg('旧格式问题', T1),
      {
        role: 'assistant',
        content: '旧回答',
        timestamp: T1 + sec(2),
      },
    ]
    const view = projectTrajectory({ sessionId: 's-1', messages, subExecutions: [] })
    const kinds = view.turns[0]?.records.map((r) => r.kind)
    assert.deepEqual(kinds, ['user', 'call'])
    assert.equal(view.turns[0]?.records[1]?.thinking, undefined)
    assert.equal(view.turns[0]?.records[1]?.reply, '旧回答')
  })

  void it('非法 sections 载荷静默跳过该段而不中断投影', () => {
    const messages: DisplayMessage[] = [
      userMsg('问题', T1),
      assistantMsg(
        [{ type: 'tool_group', tools: 'not-an-array' }, { type: 'unknown_type' }, null],
        T1 + sec(2),
        T1
      ),
    ]
    const view = projectTrajectory({ sessionId: 's-1', messages, subExecutions: [] })
    assert.deepEqual(
      view.turns[0]?.records.map((r) => r.kind),
      ['user']
    )
  })

  void it('空会话投影为空视图而不是报错', () => {
    const view = projectTrajectory({ sessionId: 's-empty', messages: [], subExecutions: [] })
    assert.equal(view.sessionId, 's-empty')
    assert.deepEqual(view.turns, [])
    assert.equal(view.totalTokens, null)
    assert.equal(view.activeMs, 0)
    assert.equal(view.spanMs, 0)
  })
})
