import { describe, expect, it } from 'vitest'

import {
  hasPrecedingCall,
  type TrajectoryRecord,
  type TrajectoryRecordKind,
} from '../trajectoryTypes'

/**
 * 工具归属的**安全属性**测试（对应 spec 的 R4）。
 *
 * 事实日志里工具事实必然排在其所属 assistant 事实之后（LLM 消息协议保证），
 * 投影按位置把工具挂在「本轮最近一次 call」之下。这里锁住的是**顺序异常时的降级行为**：
 * 必须表现为「没分组」，绝不能挂到上一条调用——分错组比不分组更难发现。
 */

function rec(kind: TrajectoryRecordKind, id: string): TrajectoryRecord {
  return { id, kind, at: '14:00:00', summary: id }
}

describe('hasPrecedingCall：工具归属判定', () => {
  it('call 之后的工具归属到该 call', () => {
    const records = [rec('user', 'u1'), rec('call', 'c1'), rec('tool', 't1')]
    expect(hasPrecedingCall(records, 2)).toBe(true)
  })

  it('跨过多个工具仍归到最近一次 call', () => {
    const records = [
      rec('user', 'u1'),
      rec('call', 'c1'),
      rec('tool', 't1'),
      rec('tool', 't2'),
      rec('call', 'c2'),
      rec('tool', 't3'),
    ]
    expect(hasPrecedingCall(records, 5)).toBe(true)
  })

  it('工具出现在任何 call 之前：降级为不分组，不挂上一条调用', () => {
    // 顺序异常（如 run 被恢复后工具事实落在新 run 的开头）
    expect(hasPrecedingCall([rec('tool', 't1')], 0)).toBe(false)
  })

  it('新一轮 user 之后的工具不得归到上一轮的 call', () => {
    const records = [rec('user', 'u1'), rec('call', 'c1'), rec('user', 'u2'), rec('tool', 't1')]
    expect(hasPrecedingCall(records, 3)).toBe(false)
  })

  it('user 本身没有归属（调用方只对 tool/subagent 用它）', () => {
    expect(hasPrecedingCall([rec('user', 'u1'), rec('user', 'u2')], 1)).toBe(false)
  })
})
