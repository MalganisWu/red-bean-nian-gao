import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiCall } from '@/services/api/client'

// Mock API client：与真实 client 解耦
vi.mock('@/services/api/client', () => ({
  apiCall: vi.fn(),
}))

// Mock auth store：apiCall 从中读取 token
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ token: 'test-token' }),
  },
}))

import { fetchSessions, fetchSession } from '../session'

const mockApiCall = vi.mocked(apiCall)

describe('fetchSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should call GET /api/sessions without cursor by default', async () => {
    mockApiCall.mockResolvedValueOnce({ sessions: [], next_cursor: '' })

    const result = await fetchSessions()

    const [path, options, decoder] = mockApiCall.mock.calls[0]
    expect(path).toBe('/api/sessions?cursor=&limit=20')
    expect(options).toEqual({})
    expect(typeof decoder).toBe('function')
    expect(result.sessions).toEqual([])
    expect(result.next_cursor).toBe('')
  })

  it('should pass cursor and limit parameters', async () => {
    mockApiCall.mockResolvedValueOnce({ sessions: [], next_cursor: 'cursor-xyz' })

    const result = await fetchSessions('prev-cursor', 10)

    const [path] = mockApiCall.mock.calls[0]
    expect(path).toBe('/api/sessions?cursor=prev-cursor&limit=10')
    expect(result.next_cursor).toBe('cursor-xyz')
  })

  it('should return sessions sorted as received from API', async () => {
    const mockSessions = [
      { id: 'sess_3', title: '最新对话', message_count: 5, updated_at: '2026-07-08T10:00:00Z' },
      { id: 'sess_1', title: '旧对话', message_count: 2, updated_at: '2026-07-07T10:00:00Z' },
    ]
    mockApiCall.mockResolvedValueOnce({ sessions: mockSessions, next_cursor: '' })

    const result = await fetchSessions()

    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[0].id).toBe('sess_3')
  })

  it('should propagate API errors', async () => {
    mockApiCall.mockRejectedValueOnce(new Error('Network error'))

    await expect(fetchSessions()).rejects.toThrow('Network error')
  })
})

describe('fetchSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should call GET /api/sessions/:id', async () => {
    const mockDetail = {
      id: 'sess_123',
      messages: [
        { role: 'user', content: 'hello', timestamp: 1000 },
        { role: 'assistant', content: 'hi', timestamp: 2000 },
      ],
    }
    mockApiCall.mockResolvedValueOnce(mockDetail)

    const result = await fetchSession('sess_123')

    const [path, options, decoder] = mockApiCall.mock.calls[0]
    expect(path).toBe('/api/sessions/sess_123')
    expect(options).toEqual({})
    expect(typeof decoder).toBe('function')
    expect(result.id).toBe('sess_123')
    expect(result.messages).toHaveLength(2)
  })

  it('should handle empty messages', async () => {
    mockApiCall.mockResolvedValueOnce({ id: 'sess_empty', messages: [] })

    const result = await fetchSession('sess_empty')

    expect(result.messages).toEqual([])
  })
})
