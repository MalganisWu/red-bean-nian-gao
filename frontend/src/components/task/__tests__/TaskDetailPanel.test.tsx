import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TaskDetailPanel } from '../TaskDetailPanel'
import { useTaskStore } from '@/stores/task-store'
import type { Task } from '@/types/task'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { toast } from 'sonner'

const baseTask = {
  TaskID: 't1',
  SessionID: 's1',
  TaskInput: '每天早上 8 点帮我搜集 AI 新闻',
  ScheduleType: 'recurring',
  CronExpr: '0 8 * * *',
  NextRunAt: '2026-08-27T08:00:00Z',
  RetryCount: 2,
  IsActive: true,
} as Task

function setupStore(overrides: Partial<ReturnType<typeof useTaskStore.getState>> = {}) {
  useTaskStore.setState({
    currentTask: baseTask,
    currentTaskLoading: false,
    executions: [],
    executionsLoading: false,
    executionsNextCursor: null,
    error: null,
    loadTaskDetail: vi.fn(),
    loadExecutions: vi.fn(),
    loadExecutionViewStates: vi.fn(),
    toggleTaskActive: vi.fn(async () => {}),
    deleteTask: vi.fn(async () => {}),
    ...overrides,
  })
}

describe('TaskDetailPanel 头部动作', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
  })

  it('删除需两步确认：第一次点击只转为确认态，不调 deleteTask', () => {
    const deleteTask = vi.fn(async () => {})
    setupStore({ deleteTask })
    render(
      <TaskDetailPanel
        taskId="t1"
        activeTab="overview"
        backLabel="返回"
        onBack={() => {}}
        onTabChange={() => {}}
        onDeleted={() => {}}
        onViewExecution={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    fireEvent.click(screen.getByText('删除任务'))
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    expect(screen.getByText(/确认删除/)).toBeInTheDocument()
    expect(screen.getByText('删除后停止后续执行；历史执行记录仍保留。')).toBeInTheDocument()
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it('确认态再点才执行删除，成功后 toast 并回调 onDeleted', async () => {
    const deleteTask = vi.fn(async () => {})
    const onDeleted = vi.fn()
    setupStore({ deleteTask })
    render(
      <TaskDetailPanel
        taskId="t1"
        activeTab="overview"
        backLabel="返回"
        onBack={() => {}}
        onTabChange={() => {}}
        onDeleted={onDeleted}
        onViewExecution={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    fireEvent.click(screen.getByText('删除任务'))
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    fireEvent.click(screen.getByText(/确认删除/))
    await waitFor(() => expect(deleteTask).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalledWith('已删除任务')
  })

  it('删除失败：不跳转，toast 报错并退出确认态', async () => {
    const deleteTask = vi.fn(async () => {
      useTaskStore.setState({ error: '删除失败：网络错误' })
    })
    const onDeleted = vi.fn()
    setupStore({ deleteTask })
    render(
      <TaskDetailPanel
        taskId="t1"
        activeTab="overview"
        backLabel="返回"
        onBack={() => {}}
        onTabChange={() => {}}
        onDeleted={onDeleted}
        onViewExecution={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    fireEvent.click(screen.getByText('删除任务'))
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    fireEvent.click(screen.getByText(/确认删除/))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('删除失败：网络错误'))
    expect(onDeleted).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    expect(screen.getByText('删除任务')).toBeInTheDocument()
  })

  it('暂停成功反馈「已暂停」toast；失败 toast 报错', async () => {
    const toggleTaskActive = vi.fn(async () => {})
    setupStore({ toggleTaskActive })
    render(
      <TaskDetailPanel
        taskId="t1"
        activeTab="overview"
        backLabel="返回"
        onBack={() => {}}
        onTabChange={() => {}}
        onDeleted={() => {}}
        onViewExecution={() => {}}
      />
    )
    fireEvent.click(screen.getByText('暂停'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已暂停'))
  })

  it('暂停请求期间原位显示 pending 并只锁定当前动作', async () => {
    let resolveToggle: (() => void) | undefined
    const toggleTaskActive = vi.fn(() => new Promise<void>((resolve) => (resolveToggle = resolve)))
    setupStore({ toggleTaskActive })
    render(
      <TaskDetailPanel
        taskId="t1"
        activeTab="overview"
        backLabel="返回"
        onBack={() => {}}
        onTabChange={() => {}}
        onDeleted={() => {}}
        onViewExecution={() => {}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    const pending = screen.getByRole('button', { name: '正在暂停…' })
    expect(pending).toBeDisabled()
    expect(screen.getByRole('button', { name: /更多操作/ })).not.toBeDisabled()

    resolveToggle?.()
    await waitFor(() => expect(screen.getByRole('button', { name: '暂停' })).not.toBeDisabled())
  })

  it('确认删除后在原操作区显示 pending', async () => {
    let resolveDelete: (() => void) | undefined
    const deleteTask = vi.fn(() => new Promise<void>((resolve) => (resolveDelete = resolve)))
    const onDeleted = vi.fn()
    setupStore({ deleteTask })
    render(
      <TaskDetailPanel
        taskId="t1"
        activeTab="overview"
        backLabel="返回"
        onBack={() => {}}
        onTabChange={() => {}}
        onDeleted={onDeleted}
        onViewExecution={() => {}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    fireEvent.click(screen.getByText('删除任务'))
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }))
    fireEvent.click(screen.getByText(/确认删除/))
    expect(screen.getByRole('status')).toHaveTextContent('正在删除…')

    resolveDelete?.()
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })
})
