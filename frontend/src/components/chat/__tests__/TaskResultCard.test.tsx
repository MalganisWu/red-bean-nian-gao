import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DisplayMessage, MessageSection } from '@/types/chat'
import { useTaskStore } from '@/stores/task-store'

// Mock design-system 组件：这些组件在 vitest 下触发 React 双实例（design-system 的依赖走自己的 React，
// useContext 读到 null）。与 MessageCard-ask 测试 mock QuestionCard 一致——只断言 TaskResultCard 传给它们的 props。
// ReasoningBlock / ToolGroup：渲染成纯文本（拼接 items.content / tools.name），可被 getByText 断言。
vi.mock('@/components/retroui/ReasoningBlock', () => ({
  // 过程收束后工具作为 tool items 进 ReasoningBlock：content 与 tool.name 都渲染
  ReasoningBlock: (props: { items?: { content?: string; tool?: { name?: string } }[] }) =>
    (props.items ?? []).map((i) => i.content ?? i.tool?.name ?? '').join(' '),
}))

import { TaskResultCard } from '@/components/chat/TaskResultCard'
import { getTaskResultDefaultCollapsed } from '@/components/chat/taskResultState'

function contentSection(text: string): MessageSection {
  return { type: 'content', content: text, timestamp: 100 }
}

function reasonSection(): MessageSection {
  return {
    type: 'reason',
    items: [{ itemType: 'step', index: 1, content: '尝试获取汇率行情' }],
    timestamp: 200,
  }
}

function toolGroupSection(): MessageSection {
  return {
    type: 'tool_group',
    tools: [{ callId: 'c1', name: 'fetch_exchange_rate', status: 'failed', error: '上游接口 502' }],
    timestamp: 300,
  }
}

function scheduledMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 1000,
    source: 'scheduled_task',
    meta: {
      scheduled_task: {
        task_id: 't1',
        task_name: '每天 9 点获取汇率简报',
        status: 'completed',
        execution_id: 'e1',
        scheduled_at: 1722751200000,
        completed_at: 1722751203500,
      },
    },
    ...overrides,
  }
}

describe('TaskResultCard', () => {
  beforeEach(() => {
    useTaskStore.getState().reset()
    useTaskStore.setState({
      executionViewStates: {
        e1: {
          execution_id: 'e1',
          seen_at: null,
          collapsed_override: null,
          updated_at: null,
        },
      },
      executionViewStatesLoaded: { e1: true },
    })
  })

  it('成功：外壳 + 主区最终输出，无「查看执行过程」', () => {
    render(
      <TaskResultCard
        message={scheduledMessage({ sections: [contentSection('今日汇率 USD/CNY 7.15')] })}
      />
    )
    expect(screen.getByText('每天 9 点获取汇率简报')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText('今日汇率 USD/CNY 7.15')).toBeInTheDocument()
    expect(screen.queryByText('查看执行过程')).not.toBeInTheDocument()
  })

  it('失败：主区失败原因 + 复用同一 Process 轨道', () => {
    const scheduledTask = scheduledMessage().meta?.scheduled_task
    if (!scheduledTask) throw new Error('定时任务元信息缺失')
    render(
      <TaskResultCard
        message={scheduledMessage({
          meta: {
            scheduled_task: { ...scheduledTask, status: 'failed' },
          },
          sections: [
            contentSection('任务执行失败：AI 服务暂时不可用（LLM 调用失败），已自动重试 3 次'),
            reasonSection(),
            toolGroupSection(),
          ],
        })}
      />
    )
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/任务执行失败/)).toBeInTheDocument()
    expect(screen.getByText('执行失败')).toBeInTheDocument()
    expect(screen.getByText(/尝试获取汇率行情/)).toBeInTheDocument()
    expect(screen.getByText(/fetch_exchange_rate/)).toBeInTheDocument()
  })

  it('无 meta → 渲染 null', () => {
    const { container } = render(
      <TaskResultCard message={{ id: 'm1', role: 'assistant', content: 'x', timestamp: 1 }} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('无 sections 有 content → 主区显示 content', () => {
    render(
      <TaskResultCard message={scheduledMessage({ content: '纯文本结果', sections: undefined })} />
    )
    expect(screen.getByText('纯文本结果')).toBeInTheDocument()
  })

  it('失败结果只有 content 时仍显示显式失败 Process', () => {
    const scheduledTask = scheduledMessage().meta?.scheduled_task
    if (!scheduledTask) throw new Error('定时任务元信息缺失')
    render(
      <TaskResultCard
        message={scheduledMessage({
          content: '任务执行失败：AI 服务暂时不可用',
          sections: undefined,
          meta: {
            scheduled_task: { ...scheduledTask, status: 'failed' },
          },
        })}
      />
    )
    expect(screen.getByText('执行失败')).toBeInTheDocument()
    expect(screen.getByText('任务执行失败：AI 服务暂时不可用')).toBeInTheDocument()
  })

  it('已读历史成功默认收起，但最新结果和手动覆盖保持展开', () => {
    const seenState = {
      execution_id: 'e1',
      seen_at: '2026-08-28T09:00:00Z',
      collapsed_override: null,
      updated_at: '2026-08-28T09:00:00Z',
    }
    expect(
      getTaskResultDefaultCollapsed({ status: 'completed', isLatest: false, viewState: seenState })
    ).toBe(true)
    expect(
      getTaskResultDefaultCollapsed({ status: 'completed', isLatest: true, viewState: seenState })
    ).toBe(false)
    expect(
      getTaskResultDefaultCollapsed({
        status: 'completed',
        isLatest: false,
        viewState: { ...seenState, collapsed_override: false },
      })
    ).toBe(false)
  })

  it('结果折叠与任务详情按钮相互独立', async () => {
    const saveCollapsed = vi.fn().mockResolvedValue(true)
    useTaskStore.setState({ setExecutionCollapsed: saveCollapsed })
    render(
      <TaskResultCard message={scheduledMessage({ sections: [contentSection('可折叠结果')] })} />
    )

    fireEvent.click(screen.getByRole('button', { name: /收起结果/ }))

    await waitFor(() => expect(screen.queryByText('可折叠结果')).not.toBeInTheDocument())
    expect(screen.getByText(/执行结果已收起/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /展开结果/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(saveCollapsed).toHaveBeenCalledWith('t1', 'e1', true)
    expect(screen.getByRole('button', { name: /定时任务/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('服务端记录为已读的历史成功结果在加载后默认收起', async () => {
    useTaskStore.setState({
      executionViewStates: {
        e1: {
          execution_id: 'e1',
          seen_at: '2026-08-28T09:00:00Z',
          collapsed_override: null,
          updated_at: '2026-08-28T09:00:00Z',
        },
      },
      executionViewStatesLoaded: { e1: true },
    })

    render(
      <TaskResultCard
        message={scheduledMessage({ sections: [contentSection('历史结果')] })}
        isLatest={false}
      />
    )

    await waitFor(() => expect(screen.queryByText('历史结果')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /展开结果/ })).toBeInTheDocument()
  })

  it('服务端状态未返回前不短暂渲染历史正文', async () => {
    useTaskStore.getState().reset()
    render(
      <TaskResultCard
        message={scheduledMessage({ sections: [contentSection('不应闪现的历史结果')] })}
        isLatest={false}
      />
    )

    expect(screen.queryByText('不应闪现的历史结果')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在读取执行结果显示状态')

    useTaskStore.setState({
      executionViewStates: {
        e1: {
          execution_id: 'e1',
          seen_at: '2026-08-28T09:00:00Z',
          collapsed_override: null,
          updated_at: '2026-08-28T09:00:00Z',
        },
      },
      executionViewStatesLoaded: { e1: true },
    })

    await waitFor(() => expect(screen.getByText(/执行结果已收起/)).toBeInTheDocument())
  })
})
