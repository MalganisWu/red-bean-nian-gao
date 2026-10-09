import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 会话 API：隔离 store 的网络依赖
const mockFetchSessions = vi.hoisted(() => vi.fn())
const mockFetchSession = vi.hoisted(() => vi.fn())
vi.mock('@/services/api/session', () => ({
  fetchSessions: mockFetchSessions,
  fetchSession: mockFetchSession,
}))

import { useChatStore } from '../chat-store'

// 每个用例前重置 store 状态
beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.setState({
    sessions: [],
    nextCursor: '',
    sessionsLoading: false,
    activeSessionId: null,
    messages: [],
  })
})

describe('loadSessions', () => {
  it('should load first page of sessions', async () => {
    const mockData = {
      sessions: [
        { id: 's1', title: '会话1', message_count: 3, updated_at: '2026-07-08T10:00:00Z' },
        { id: 's2', title: '会话2', message_count: 1, updated_at: '2026-07-07T10:00:00Z' },
      ],
      next_cursor: 'cursor-page2',
    }
    mockFetchSessions.mockResolvedValueOnce(mockData)

    await useChatStore.getState().loadSessions()

    const state = useChatStore.getState()
    expect(state.sessions).toEqual(mockData.sessions)
    expect(state.nextCursor).toBe('cursor-page2')
    expect(state.sessionsLoading).toBe(false)
  })

  it('should set loading state while fetching', async () => {
    mockFetchSessions.mockImplementationOnce(
      () =>
        new Promise<{ sessions: never[]; next_cursor: string }>((r) =>
          setTimeout(() => r({ sessions: [], next_cursor: '' }), 10)
        )
    )

    const promise = useChatStore.getState().loadSessions()
    expect(useChatStore.getState().sessionsLoading).toBe(true)

    await promise
    expect(useChatStore.getState().sessionsLoading).toBe(false)
  })
})

describe('loadMoreSessions', () => {
  it('should append next page to existing sessions', async () => {
    // 预置会话列表与游标：验证分页加载追加行为
    useChatStore.setState({
      sessions: [
        { id: 's1', title: '会话1', message_count: 2, updated_at: '2026-07-08T10:00:00Z' },
      ],
      nextCursor: 'cursor-p2',
    })

    const moreData = {
      sessions: [
        { id: 's2', title: '会话2', message_count: 1, updated_at: '2026-07-07T10:00:00Z' },
      ],
      next_cursor: '',
    }
    mockFetchSessions.mockResolvedValueOnce(moreData)

    await useChatStore.getState().loadMoreSessions()

    const state = useChatStore.getState()
    expect(state.sessions).toHaveLength(2)
    expect(state.sessions[0].id).toBe('s1')
    expect(state.sessions[1].id).toBe('s2')
    expect(state.nextCursor).toBe('')
  })

  it('should not fetch if nextCursor is empty', async () => {
    useChatStore.setState({ nextCursor: '' })

    await useChatStore.getState().loadMoreSessions()

    expect(mockFetchSessions).not.toHaveBeenCalled()
  })
})

describe('switchSession', () => {
  it('should load session messages and set activeSessionId', async () => {
    const mockDetail = {
      id: 'sess_active',
      messages: [
        { role: 'user', content: 'hello', timestamp: 1000 },
        { role: 'assistant', content: 'hi there', timestamp: 2000 },
      ],
    }
    mockFetchSession.mockResolvedValueOnce(mockDetail)

    await useChatStore.getState().switchSession('sess_active')

    const state = useChatStore.getState()
    expect(state.activeSessionId).toBe('sess_active')
    expect(state.sessionId).toBe('sess_active')
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0].content).toBe('hello')
  })

  it('should stop streaming when switching', async () => {
    useChatStore.setState({ isStreaming: true })

    mockFetchSession.mockResolvedValueOnce({
      id: 'sess_other',
      messages: [],
    })

    await useChatStore.getState().switchSession('sess_other')

    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('should carry source and meta through recovery (task result card survives refresh)', async () => {
    const mockDetail = {
      id: 'sess_sched',
      messages: [
        {
          role: 'assistant',
          content: '',
          timestamp: 2000,
          source: 'scheduled_task',
          meta: {
            scheduled_task: {
              task_id: 't1',
              task_name: '提醒我明天开会',
              status: 'completed',
              execution_id: 'e1',
              scheduled_at: 1722751200000,
              completed_at: 1722751203500,
            },
          },
        },
      ],
    }
    mockFetchSession.mockResolvedValueOnce(mockDetail)

    await useChatStore.getState().switchSession('sess_sched')

    const state = useChatStore.getState()
    expect(state.messages[0].source).toBe('scheduled_task')
    expect(state.messages[0].meta?.scheduled_task?.task_name).toBe('提醒我明天开会')
    expect(state.messages[0].meta?.scheduled_task?.status).toBe('completed')
  })

  it('为相同时间戳的历史消息生成稳定且唯一的运行时 id', async () => {
    mockFetchSession.mockResolvedValueOnce({
      id: 'sess_duplicate_timestamp',
      messages: [
        { role: 'assistant', content: '第一段', timestamp: 2000 },
        { role: 'assistant', content: '第二段', timestamp: 2000 },
      ],
    })

    await useChatStore.getState().switchSession('sess_duplicate_timestamp')

    const ids = useChatStore.getState().messages.map((message) => message.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      'msg_sess_duplicate_timestamp_0_2000',
      'msg_sess_duplicate_timestamp_1_2000',
    ])
  })
})

describe('newSession', () => {
  it('should reset messages and active session', () => {
    // 预置状态：验证 newSession 全量清空
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: 'old', timestamp: 1000 }],
      activeSessionId: 'sess_old',
      sessionId: 'sess_old',
      isStreaming: true,
      requestId: 'req_old',
      status: '正在执行',
      sentAt: 1234,
    })

    useChatStore.getState().newSession()

    const state = useChatStore.getState()
    expect(state.messages).toEqual([])
    expect(state.activeSessionId).toBeNull()
    expect(state.sessionId).toBeNull()
    expect(state.requestId).toBeNull()
    expect(state.status).toBeNull()
    expect(state.sentAt).toBe(0)
    expect(state.isStreaming).toBe(false)
  })
})
