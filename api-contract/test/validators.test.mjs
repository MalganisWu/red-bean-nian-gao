import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildPath,
  isSessionDetail,
  isSessionTrajectory,
  isTask,
  isTaskExecution,
  objectPathSchema,
} from '../dist/index.js'

void describe('共享 API 运行时契约', () => {
  void it('接受未生成 NextRunAt 的任务', () => {
    assert.equal(
      isTask({
        TaskID: 'task-1',
        UserID: 'user-1',
        SessionID: 'session-1',
        TaskInput: '提醒喝水',
        CronExpr: '',
        ScheduleType: 'once',
        IsActive: true,
        RetryCount: 0,
      }),
      true
    )
  })

  void it('要求任务执行显式携带 nullable 字段', () => {
    const complete = {
      ExecutionID: 'execution-1',
      TaskID: 'task-1',
      SessionID: 'session-1',
      Status: 'completed',
      ScheduledAt: '2026-09-07T10:00:00Z',
      StartedAt: null,
      CompletedAt: null,
      DisplayMessages: [],
      ResultType: null,
      ResultMessage: null,
      ErrorMessage: null,
    }
    assert.equal(isTaskExecution(complete), true)
    const { ResultType: _missing, ...incomplete } = complete
    assert.equal(isTaskExecution(incomplete), false)
  })

  void it('拒绝包含无效展示消息的会话详情', () => {
    assert.equal(
      isSessionDetail({ id: 'session-1', messages: [{ role: 'assistant', timestamp: 1 }] }),
      true
    )
    assert.equal(
      isSessionDetail({ id: 'session-1', messages: [{ role: 'system', timestamp: 1 }] }),
      false
    )
  })

  void it('对象 key 校验接受含斜杠路径并拒绝空值与 .. 段', () => {
    assert.equal(objectPathSchema.safeParse({ '*': 'uploads/user-1/a.png' }).success, true)
    assert.equal(objectPathSchema.safeParse({ '*': 'a/b/c.png' }).success, true)
    assert.equal(objectPathSchema.safeParse({ '*': '' }).success, false)
    assert.equal(objectPathSchema.safeParse({ '*': 'uploads/../x.png' }).success, false)
    assert.equal(objectPathSchema.safeParse({ '*': '../x.png' }).success, false)
  })

  void it('buildPath 替换 :param 占位符且不影响通配与缺失参数', () => {
    assert.equal(buildPath('/api/tasks/:id', { id: 'task-1' }), '/api/tasks/task-1')
    assert.equal(
      buildPath('/api/tasks/:id/executions/:eid', { id: 't', eid: 'e' }),
      '/api/tasks/t/executions/e'
    )
    assert.equal(buildPath('/api/me'), '/api/me')
    assert.equal(buildPath('/api/storage/download/*', {}), '/api/storage/download/*')
    // 缺失占位符原样保留，避免静默生成错误 URL
    assert.equal(buildPath('/api/tasks/:id'), '/api/tasks/:id')
  })

  void it('会话轨迹校验接受完整响应并拒绝非法形状', () => {
    const record = {
      id: 'r1',
      seq: 1,
      kind: 'user',
      at: 1757570531000,
      summary: '帮我调研红豆年糕',
    }
    const trajectory = {
      sessionId: 'session-1',
      title: '调研红豆年糕做法并创建提醒',
      turns: [
        {
          turn: 1,
          startedAt: 1757570531000,
          durationMs: 12400,
          tokens: null,
          records: [record],
          endState: { state: 'completed', at: 1757570543000 },
        },
      ],
      compaction: null,
      sessionEnd: { state: 'completed', at: 1757570551000 },
      totalTokens: null,
      subAgentTokens: 12430,
      activeMs: 47300,
      spanMs: 421000,
    }
    assert.equal(isSessionTrajectory(trajectory), true)
    // G0 允许 tokens / attempts / endState 为 null（未采集）
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [{ ...trajectory.turns[0], tokens: null, endState: null }],
      }),
      true
    )
    // 层级重构后的 call 记录：attempts 明细 + waitMs（审批等待时长）合法
    const callRecord = {
      id: 'r2',
      seq: 2,
      kind: 'call',
      at: 1757570532000,
      summary: '规划：先搜索资料',
      tokens: { input: 3218, output: 412, cache: 0 },
      attempts: [
        {
          id: 'a1',
          seq: 1,
          model: 'deepseek-chat',
          attempt: '1/1',
          durationMs: 4300,
          tokens: { input: 3218, output: 412, cache: 0 },
          status: 'success',
          at: 1757570532000,
        },
      ],
    }
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [{ ...trajectory.turns[0], records: [callRecord] }],
      }),
      true
    )
    // 审批挂起：waitMs 与工具记录共存
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [
          {
            ...trajectory.turns[0],
            records: [{ ...callRecord, kind: 'tool', name: 'ask_user', waitMs: 192000 }],
            endState: { state: 'interrupt', at: 1757570543000 },
          },
        ],
      }),
      true
    )
    // 崩溃遗留用 crashed（与 interrupt 区分：前者进程、后者 LLM 发起）
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [
          {
            ...trajectory.turns[0],
            endState: { state: 'crashed', at: 1757570543000 },
          },
        ],
      }),
      true
    )
    // 记录级 interrupt / incomplete 合法；attempt 级不接受这两个值
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [
          {
            ...trajectory.turns[0],
            records: [{ ...callRecord, status: 'interrupt' }],
          },
        ],
      }),
      true
    )
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [
          {
            ...trajectory.turns[0],
            records: [{ ...callRecord, status: 'incomplete' }],
          },
        ],
      }),
      true
    )
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [
          {
            ...trajectory.turns[0],
            records: [
              { ...callRecord, attempts: [{ ...callRecord.attempts[0], status: 'interrupt' }] },
            ],
          },
        ],
      }),
      false
    )
    // 旧的 step / request kind 已随层级重构移除：必须被拒绝，不得静默放行
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [{ ...trajectory.turns[0], records: [{ ...record, kind: 'step' }] }],
      }),
      false
    )
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [{ ...trajectory.turns[0], records: [{ ...record, kind: 'request' }] }],
      }),
      false
    )
    // attempts 形状非法（缺 model）时拒绝
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [
          {
            ...trajectory.turns[0],
            records: [{ ...callRecord, attempts: [{ id: 'a1', seq: 1 }] }],
          },
        ],
      }),
      false
    )
    // 非法形状：未知 kind / 缺 summary / 未知压缩状态
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [{ ...trajectory.turns[0], records: [{ ...record, kind: 'unknown' }] }],
      }),
      false
    )
    assert.equal(
      isSessionTrajectory({
        ...trajectory,
        turns: [{ ...trajectory.turns[0], records: [{ ...record, summary: 1 }] }],
      }),
      false
    )
    assert.equal(isSessionTrajectory({ ...trajectory, compaction: { status: 'weird' } }), false)
  })
})
