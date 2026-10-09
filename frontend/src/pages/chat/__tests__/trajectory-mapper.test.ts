import { describe, expect, it } from 'vitest'

import type { SessionTrajectoryDto } from '@red-bean/api-contract'

import { formatEpochToClock, mapSessionTrajectory } from '../trajectory-mapper'

/** 本地时间构造测试时刻，与 formatEpochToClock 的本地读法一致，避免手算 epoch 的时区误差。 */
const T_14_02_11 = new Date(2026, 8, 11, 14, 2, 11).getTime()
const T_14_02_12 = new Date(2026, 8, 11, 14, 2, 12).getTime()
const T_14_02_23 = new Date(2026, 8, 11, 14, 2, 23).getTime()
const T_14_07_58 = new Date(2026, 8, 11, 14, 7, 58).getTime()
const T_14_09_11 = new Date(2026, 8, 11, 14, 9, 11).getTime()

describe('trajectory-mapper：wire DTO → 组件视图模型', () => {
  it('epoch 毫秒格式化为 HH:MM:SS', () => {
    expect(formatEpochToClock(T_14_02_11)).toBe('14:02:11')
  })

  it('映射轮次与记录，空值字段不落到组件模型', () => {
    const dto: SessionTrajectoryDto = {
      sessionId: 's-1',
      title: '测试会话',
      turns: [
        {
          turn: 1,
          startedAt: T_14_02_11,
          durationMs: 12400,
          tokens: null,
          records: [
            { id: 'r1', seq: 1, kind: 'user', at: T_14_02_11, summary: '问题' },
            {
              id: 'r2',
              seq: 2,
              kind: 'call',
              at: T_14_02_12,
              summary: '规划',
              durationMs: 4300,
              tokens: null,
              attempts: [],
              thinking: '想',
            },
          ],
          endState: { state: 'completed', at: T_14_02_23 },
        },
      ],
      compaction: null,
      sessionEnd: null,
      totalTokens: null,
      subAgentTokens: 12430,
      activeMs: 47300,
      spanMs: 421000,
    }
    const view = mapSessionTrajectory(dto)
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.startedAt).toBe('14:02:11')
    expect(view.turns[0]?.tokens).toBeNull()
    expect(view.turns[0]?.endState?.at).toBe('14:02:23')
    const call = view.turns[0]?.records[1]
    expect(call?.kind).toBe('call')
    expect(call?.at).toBe('14:02:12')
    expect(call?.thinking).toBe('想')
    // G0：tokens null 不落进组件模型（组件显示未采集占位）
    expect(call?.tokens).toBeUndefined()
    expect(view.totalTokens).toBeNull()
    expect(view.compaction).toBeUndefined()
    expect(view.sessionEnd).toBeUndefined()
  })

  it('映射压缩事件与请求子记录', () => {
    const dto: SessionTrajectoryDto = {
      sessionId: 's-1',
      title: 't',
      turns: [],
      compaction: {
        id: 'c1',
        seq: 19,
        afterTurn: 2,
        at: T_14_07_58,
        durationMs: 3200,
        beforeTokens: 42300,
        afterTokens: 8100,
        messages: 26,
        strategy: '保留最近 2 轮',
        status: 'success',
      },
      sessionEnd: { state: 'completed', at: T_14_09_11 },
      totalTokens: 54690,
      subAgentTokens: 0,
      activeMs: 47300,
      spanMs: 421000,
    }
    const view = mapSessionTrajectory(dto)
    expect(view.compaction?.at).toBe('14:07:58')
    expect(view.compaction?.beforeTokens).toBe(42300)
    expect(view.sessionEnd?.state).toBe('completed')
  })
})
