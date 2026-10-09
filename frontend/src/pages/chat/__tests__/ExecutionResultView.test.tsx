import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTaskStore } from '@/stores/task-store'
import type { Task, TaskExecution } from '@/types/task'

import { ExecutionResultView } from '../ExecutionResultView'

const task: Task = {
  TaskID: 'task-1',
  SessionID: 'session-1',
  UserID: 'user-1',
  TaskInput: '每日质量摘要\n检查过去 24 小时的数据质量。',
  ScheduleType: 'recurring',
  CronExpr: '30 8 * * *',
  IsActive: true,
  RetryCount: 0,
  NextRunAt: '2026-08-29T08:30:00',
}

const execution: TaskExecution = {
  ExecutionID: 'execution-1',
  TaskID: 'task-1',
  SessionID: 'session-1',
  Status: 'completed',
  ScheduledAt: '2026-08-28T08:30:00',
  StartedAt: '2026-08-28T08:30:01',
  CompletedAt: '2026-08-28T08:30:04',
  DisplayMessages: [],
  ResultType: null,
  ResultMessage: '## 今日结果\n\n全部指标正常。',
  ErrorMessage: null,
}

describe('ExecutionResultView', () => {
  beforeEach(() => {
    useTaskStore.setState({
      currentTask: task,
      currentTaskLoading: false,
      activeExecution: execution,
      activeExecutionLoading: false,
      executionViewStates: {
        'execution-1': {
          execution_id: 'execution-1',
          seen_at: '2026-08-28T08:31:00Z',
          collapsed_override: null,
          updated_at: '2026-08-28T08:31:00Z',
        },
      },
      executionViewStatesLoaded: { 'execution-1': true },
      error: null,
      loadTaskDetail: vi.fn(),
      loadExecutionDetail: vi.fn(),
      loadExecutionViewStates: vi.fn(),
      markExecutionSeen: vi.fn(async () => true),
    })
  })

  it('直达执行 URL 时同时加载任务与执行，并使用独立执行头 + Markdown', async () => {
    const loadTaskDetail = useTaskStore.getState().loadTaskDetail
    const loadExecutionDetail = useTaskStore.getState().loadExecutionDetail

    render(<ExecutionResultView taskId="task-1" executionId="execution-1" onBack={() => {}} />)

    expect(screen.getByText('每日质量摘要')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Markdown 回答' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '今日结果' })).toBeInTheDocument()
    expect(screen.queryByText('定时任务 · 自动执行')).not.toBeInTheDocument()
    await waitFor(() => expect(loadTaskDetail).toHaveBeenCalledWith('task-1'))
    await waitFor(() => expect(loadExecutionDetail).toHaveBeenCalledWith('task-1', 'execution-1'))
  })
})
