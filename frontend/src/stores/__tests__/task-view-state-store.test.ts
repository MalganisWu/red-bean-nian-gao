import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/api/task', () => ({
  fetchSessionTasks: vi.fn(),
  fetchTasks: vi.fn(),
  fetchTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  fetchExecutions: vi.fn(),
  fetchExecution: vi.fn(),
  fetchExecutionViewStates: vi.fn(),
  updateExecutionViewState: vi.fn(),
}))

import {
  fetchExecution,
  fetchExecutionViewStates,
  updateExecutionViewState,
} from '@/services/api/task'
import { useTaskStore } from '@/stores/task-store'
import type { TaskExecution } from '@/types/task'

const mockFetchExecution = vi.mocked(fetchExecution)
const mockFetchStates = vi.mocked(fetchExecutionViewStates)
const mockUpdateState = vi.mocked(updateExecutionViewState)

function execution(id: string): TaskExecution {
  return {
    ExecutionID: id,
    TaskID: 'T1',
    SessionID: 'S1',
    Status: 'completed',
    ScheduledAt: '2026-08-28T09:00:00Z',
    StartedAt: null,
    CompletedAt: null,
    DisplayMessages: [],
    ResultType: null,
    ResultMessage: null,
    ErrorMessage: null,
  }
}

describe('task-store execution view state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTaskStore.getState().reset()
  })

  it('批量读取去重，并为服务端未返回的可见执行建立空状态', async () => {
    mockFetchStates.mockResolvedValue([
      {
        execution_id: 'E1',
        seen_at: '2026-08-28T09:00:00Z',
        collapsed_override: null,
        updated_at: '2026-08-28T09:00:00Z',
      },
    ])

    await useTaskStore.getState().loadExecutionViewStates(['E1', 'E2', 'E1'])

    expect(mockFetchStates).toHaveBeenCalledWith(['E1', 'E2'])
    expect(useTaskStore.getState().executionViewStates.E1.seen_at).toBeTruthy()
    expect(useTaskStore.getState().executionViewStates.E2).toEqual({
      execution_id: 'E2',
      seen_at: null,
      collapsed_override: null,
      updated_at: null,
    })
    expect(useTaskStore.getState().executionViewStatesLoaded).toMatchObject({ E1: true, E2: true })
  })

  it('手动折叠先乐观更新，保存失败后只回滚折叠字段', async () => {
    useTaskStore.setState({
      executionViewStates: {
        E1: {
          execution_id: 'E1',
          seen_at: '2026-08-28T09:00:00Z',
          collapsed_override: null,
          updated_at: null,
        },
      },
      executionViewStatesLoaded: { E1: true },
    })
    mockUpdateState.mockRejectedValue(new Error('network'))

    const promise = useTaskStore.getState().setExecutionCollapsed('T1', 'E1', true)
    expect(useTaskStore.getState().executionViewStates.E1.collapsed_override).toBe(true)
    await expect(promise).resolves.toBe(false)
    expect(useTaskStore.getState().executionViewStates.E1.collapsed_override).toBeNull()
    expect(useTaskStore.getState().executionViewStates.E1.seen_at).toBe('2026-08-28T09:00:00Z')
  })

  it('标记已读不覆盖用户已有的折叠选择', async () => {
    useTaskStore.setState({
      executionViewStates: {
        E1: {
          execution_id: 'E1',
          seen_at: null,
          collapsed_override: false,
          updated_at: null,
        },
      },
      executionViewStatesLoaded: { E1: true },
    })
    mockUpdateState.mockResolvedValue({
      execution_id: 'E1',
      seen_at: '2026-08-28T09:00:00Z',
      collapsed_override: false,
      updated_at: '2026-08-28T09:00:00Z',
    })

    await expect(useTaskStore.getState().markExecutionSeen('T1', 'E1')).resolves.toBe(true)

    expect(mockUpdateState).toHaveBeenCalledWith('T1', 'E1', { mark_seen: true })
    expect(useTaskStore.getState().executionViewStates.E1.collapsed_override).toBe(false)
  })

  it('并发的折叠响应不覆盖较新的已读字段', async () => {
    let resolveCollapsed!: (value: {
      execution_id: string
      seen_at: string | null
      collapsed_override: boolean | null
      updated_at: string | null
    }) => void
    mockUpdateState.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCollapsed = resolve
      })
    )

    const save = useTaskStore.getState().setExecutionCollapsed('T1', 'E1', true)
    useTaskStore.setState((state) => ({
      executionViewStates: {
        ...state.executionViewStates,
        E1: {
          ...state.executionViewStates.E1,
          seen_at: '2026-08-28T09:00:02Z',
        },
      },
    }))
    resolveCollapsed({
      execution_id: 'E1',
      seen_at: null,
      collapsed_override: true,
      updated_at: '2026-08-28T09:00:01Z',
    })

    await expect(save).resolves.toBe(true)
    expect(useTaskStore.getState().executionViewStates.E1).toMatchObject({
      seen_at: '2026-08-28T09:00:02Z',
      collapsed_override: true,
    })
  })

  it('详情请求失败时清除上一条执行，且较旧响应不能覆盖新路由', async () => {
    let resolveFirst!: (value: TaskExecution) => void
    let resolveSecond!: (value: TaskExecution) => void
    mockFetchExecution
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve
        })
      )
    useTaskStore.setState({ activeExecution: execution('OLD') })

    const first = useTaskStore.getState().loadExecutionDetail('T1', 'E1')
    expect(useTaskStore.getState().activeExecution).toBeNull()
    const second = useTaskStore.getState().loadExecutionDetail('T1', 'E2')
    resolveSecond(execution('E2'))
    await second
    resolveFirst(execution('E1'))
    await first

    expect(useTaskStore.getState().activeExecution?.ExecutionID).toBe('E2')
  })

  it('批量状态读取遇到瞬时错误会自动重试', async () => {
    mockFetchStates
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValueOnce([])

    await useTaskStore.getState().loadExecutionViewStates(['E1'])

    expect(mockFetchStates).toHaveBeenCalledTimes(2)
    expect(useTaskStore.getState().executionViewStatesLoaded.E1).toBe(true)
  })

  it('批量状态读取最终失败时标记结果不可靠，并允许显式重试恢复', async () => {
    mockFetchStates.mockRejectedValue(new Error('offline'))

    await useTaskStore.getState().loadExecutionViewStates(['E1'])

    expect(useTaskStore.getState().executionViewStatesFailed.E1).toBe(true)
    expect(useTaskStore.getState().executionViewStates.E1.seen_at).toBeNull()

    mockFetchStates.mockResolvedValue([
      {
        execution_id: 'E1',
        seen_at: '2026-08-28T09:00:00Z',
        collapsed_override: null,
        updated_at: '2026-08-28T09:00:00Z',
      },
    ])
    await useTaskStore.getState().loadExecutionViewStates(['E1'])

    expect(mockFetchStates).toHaveBeenCalledTimes(4)
    expect(useTaskStore.getState().executionViewStatesFailed.E1).toBe(false)
    expect(useTaskStore.getState().executionViewStates.E1.seen_at).toBeTruthy()
  })
})
