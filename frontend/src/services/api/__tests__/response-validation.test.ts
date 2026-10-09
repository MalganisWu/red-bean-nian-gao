import { describe, expect, it } from 'vitest'

import {
  decodeEnvelopeData,
  isPublicUser,
  isSessionDetail,
  isTaskExecutionListResponse,
  isSessionListResponse,
  isUser,
} from '@/services/api/response-validation'

describe('API 响应运行时校验', () => {
  it('接受后端 /api/me 的本人用户响应', () => {
    const response: unknown = {
      code: 200,
      data: {
        id: 'user-1',
        username: 'redbean',
        email: 'redbean@example.com',
        display_name: '红豆',
      },
    }

    const user = decodeEnvelopeData(response, isUser, 'current user')

    expect(user.username).toBe('redbean')
  })

  it('区分本人用户与不含 email 的公开用户响应', () => {
    const publicUser: unknown = {
      id: 'user-2',
      username: 'lotus',
      display_name: '莲子',
    }

    expect(isPublicUser(publicUser)).toBe(true)
    expect(isUser(publicUser)).toBe(false)
  })

  it('拒绝字段类型错误的响应，而不是用类型断言放行', () => {
    const response: unknown = {
      code: 200,
      data: { sessions: [], next_cursor: 123 },
    }

    expect(() => decodeEnvelopeData(response, isSessionListResponse, 'session list')).toThrow(
      '服务器响应格式无效：session list'
    )
  })

  it('接受省略 content 且工具耗时为持久化毫秒数值的助手消息', () => {
    expect(
      isSessionDetail({
        id: 'session-1',
        messages: [
          {
            role: 'assistant',
            sections: [
              {
                type: 'tool_group',
                tools: [
                  {
                    callId: 'call-1',
                    name: 'calculator',
                    status: 'success',
                    result: '42',
                    duration: 1234,
                  },
                ],
                timestamp: 1500,
              },
              { type: 'content', content: '结构化回答', timestamp: 2000, duration: 10 },
            ],
            timestamp: 2000,
          },
        ],
      })
    ).toBe(true)
  })

  it('接受不含前端运行时 id 的任务执行持久化消息', () => {
    expect(
      isTaskExecutionListResponse({
        executions: [
          {
            ExecutionID: 'execution-1',
            TaskID: 'task-1',
            SessionID: 'session-1',
            Status: 'completed',
            ScheduledAt: '2026-09-07T10:00:00.000Z',
            StartedAt: null,
            CompletedAt: null,
            DisplayMessages: [
              { role: 'assistant', content: '执行完成', timestamp: 1_788_754_000_000 },
            ],
            ResultType: null,
            ResultMessage: null,
            ErrorMessage: null,
          },
        ],
        next_cursor: '',
      })
    ).toBe(true)
  })

  it('拒绝不符合统一契约的 reason item 形态', () => {
    const legacyScheduledMessage = {
      role: 'assistant',
      sections: [
        {
          type: 'reason',
          items: [{ step: 1, content: '正在处理', timestamp: 1_788_757_734_272 }],
          timestamp: 1_788_757_734_272,
        },
        { type: 'content', content: '该喝水啦', timestamp: 1_788_757_737_768 },
      ],
      timestamp: 1_788_757_737_768,
    }

    expect(isSessionDetail({ id: 'session-1', messages: [legacyScheduledMessage] })).toBe(false)
    expect(
      isTaskExecutionListResponse({
        executions: [
          {
            ExecutionID: 'execution-1',
            TaskID: 'task-1',
            SessionID: 'session-1',
            Status: 'completed',
            ScheduledAt: '2026-09-07T13:08:00.000Z',
            DisplayMessages: [legacyScheduledMessage],
          },
        ],
        next_cursor: '',
      })
    ).toBe(false)
  })
})
