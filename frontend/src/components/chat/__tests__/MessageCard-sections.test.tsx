import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MessageCard } from '@/components/chat/MessageCard'
import type { MessageSection, ToolCard } from '@/types/chat'

const tool = (name: string, extra?: Partial<ToolCard>): ToolCard => ({
  callId: `call_${name}`,
  name,
  status: 'success',
  ...extra,
})
const ts = 1000

// 折叠区标签按钮
const foldHead = (): HTMLButtonElement => {
  const button = screen.getByText(/过程已完成|正在执行|等待确认|执行失败|已停止/).closest('button')
  if (!button) throw new Error('Process 折叠按钮未渲染')
  return button
}

describe('MessageCard 思考过程折叠区模型', () => {
  it('过程收进折叠区，最终回答在区外；外层不再渲染段序号', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想一想' }], timestamp: ts },
      { type: 'tool_group', tools: [tool('a')], timestamp: ts },
      { type: 'content', content: '最终回答', timestamp: ts },
    ]
    const { container } = render(<MessageCard sections={sections} />)
    expect(screen.getByText('过程已完成')).toBeInTheDocument()
    expect(screen.getByText('最终回答')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Markdown 回答' })).toBeInTheDocument()
    // 外层 44px marginalia 段序号栅格已移除
    expect(container.querySelector('[class*="44px"]')).toBeNull()
  })

  it('非流式默认收拢；展开后按时序显示步骤且无编号', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想一想' }], timestamp: ts },
      { type: 'tool_group', tools: [tool('a')], timestamp: ts },
      { type: 'content', content: '最终回答', timestamp: ts },
    ]
    render(<MessageCard sections={sections} />)
    expect(foldHead()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(foldHead())
    expect(screen.getByText('想一想')).toBeInTheDocument()
    expect(screen.queryByText('01')).not.toBeInTheDocument()
  })

  it('流式中：折叠区默认展开，中间叙述在区内可见（文字不中途消失）', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '要查天气' }], timestamp: ts },
      { type: 'content', content: '我查一下', timestamp: ts },
    ]
    render(<MessageCard sections={sections} isStreaming />)
    expect(foldHead()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('我查一下')).toBeInTheDocument()
  })

  it('回合结束（isStreaming 转 false）：当前展开态保留，最终回答原位出现', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想' }], timestamp: ts },
      { type: 'content', content: '正在流出', timestamp: ts },
    ]
    const { rerender } = render(<MessageCard sections={sections} isStreaming />)
    expect(foldHead()).toHaveAttribute('aria-expanded', 'true')
    rerender(<MessageCard sections={sections} isStreaming={false} />)
    expect(foldHead()).toHaveAttribute('aria-expanded', 'true')
    // 唯一 content 晋升为最终回答，留在区外
    expect(screen.getByText('正在流出')).toBeInTheDocument()
  })

  it('无「Agent · 生成中」状态行（呼吸点即流式信号）', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想' }], timestamp: ts },
    ]
    render(<MessageCard sections={sections} isStreaming />)
    expect(screen.queryByText(/生成中/)).not.toBeInTheDocument()
  })

  it('单个 Tool 失败后仍得到 Final 时，Process 保持 completed', () => {
    const sections: MessageSection[] = [
      {
        type: 'tool_group',
        tools: [tool('first', { status: 'failed', error: '第一次失败' })],
        timestamp: ts,
      },
      {
        type: 'tool_group',
        tools: [tool('retry')],
        timestamp: ts + 1,
      },
      { type: 'content', content: '重试后完成', timestamp: ts + 2 },
    ]

    render(<MessageCard sections={sections} />)
    expect(screen.getByText('过程已完成')).toBeInTheDocument()
    expect(screen.queryByText('执行失败')).not.toBeInTheDocument()
  })

  it('只有调用方显式传入 failed，Process 才显示执行失败', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '已执行' }], timestamp: ts },
      { type: 'content', content: '任务失败说明', timestamp: ts + 1 },
    ]
    render(<MessageCard sections={sections} terminalStatus="failed" />)
    expect(screen.getByText('执行失败')).toBeInTheDocument()
  })

  it('存在 incomplete Tool 时，Process 显示已停止', () => {
    const sections: MessageSection[] = [
      {
        type: 'tool_group',
        tools: [tool('interrupted', { status: 'incomplete' })],
        timestamp: ts,
      },
    ]
    render(<MessageCard sections={sections} />)
    expect(screen.getByText('已停止')).toBeInTheDocument()
  })

  it('纯 content（无 sections）不渲染折叠区', () => {
    render(<MessageCard content="只有正文" />)
    expect(screen.queryByText('过程已完成')).not.toBeInTheDocument()
    expect(screen.getByText('只有正文')).toBeInTheDocument()
  })

  it('纯回答回合（sections 只有 content）：无折叠区，进入裸排 Markdown 正文', () => {
    render(<MessageCard sections={[{ type: 'content', content: '直接回答', timestamp: ts }]} />)
    expect(screen.queryByText('过程已完成')).not.toBeInTheDocument()
    expect(screen.getByText('直接回答')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Markdown 回答' })).toBeInTheDocument()
  })

  it('card 进入同一个 Process，等待确认时保持可见', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想' }], timestamp: ts },
      {
        type: 'card',
        card: {
          interaction_id: 'x',
          status: 'pending',
          questions: [{ id: 'q1', text: '确认？', options: ['是'], select: 'single' }],
          answers: null,
        },
        timestamp: ts,
      },
      { type: 'content', content: '最终回答', timestamp: ts },
    ]
    render(<MessageCard sections={sections} />)
    expect(screen.getByText('等待确认')).toBeInTheDocument()
    // pending approval 是 Process 内的当前节点，收起历史步骤后仍常显。
    fireEvent.click(foldHead())
    expect(screen.getByRole('heading', { name: '确认？' })).toBeInTheDocument()
  })

  it('二次提问与两次回答都在同一个 Process DOM 中', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '开始处理' }], timestamp: ts },
      {
        type: 'card',
        card: {
          interaction_id: 'first',
          status: 'answered',
          questions: [{ id: 'q1', text: '第一个问题？', options: ['继续'] }],
          answers: { q1: { kind: 'option', value: '继续' } },
        },
        timestamp: ts + 1,
      },
      { type: 'content', content: '继续执行后需要再确认', timestamp: ts + 2 },
      {
        type: 'card',
        card: {
          interaction_id: 'second',
          status: 'pending',
          questions: [{ id: 'q2', text: '第二个问题？', options: ['确认'] }],
          answers: null,
        },
        timestamp: ts + 3,
      },
    ]

    const { container } = render(<MessageCard sections={sections} />)

    expect(container.querySelectorAll('[role="group"][aria-label^="等待确认，"]')).toHaveLength(1)
    expect(screen.getByText('第一个问题？')).toBeInTheDocument()
    expect(screen.getByText('继续执行后需要再确认')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '第二个问题？' })).toBeInTheDocument()
  })
})

describe('MessageCard 回合总耗时', () => {
  it('非流式：包络公式定格（max(ts+dur) − run_started_at）', () => {
    const sections: MessageSection[] = [
      {
        type: 'reason',
        items: [{ itemType: 'step', content: '想' }],
        timestamp: 1000,
        duration: 600,
      },
      { type: 'content', content: '答', timestamp: 4800, duration: 200 },
    ]
    render(<MessageCard sections={sections} meta={{ run_started_at: 800 }} />)
    // (4800+200) − 800 = 4200ms → 4s（标签行灰色小字）
    expect(screen.getByText(/1 步 · 4s/)).toBeInTheDocument()
  })

  it('旧数据无 run_started_at：回退 min(section ts)', () => {
    const sections: MessageSection[] = [
      {
        type: 'reason',
        items: [{ itemType: 'step', content: '想' }],
        timestamp: 1000,
        duration: 600,
      },
      { type: 'content', content: '答', timestamp: 4800, duration: 200 },
    ]
    render(<MessageCard sections={sections} />)
    // (4800+200) − 1000 = 4000ms → 4s
    expect(screen.getByText(/1 步 · 4s/)).toBeInTheDocument()
  })

  it('流式中：动态耗时从首个 section 时间戳起跳', () => {
    const sections: MessageSection[] = [
      {
        type: 'reason',
        items: [{ itemType: 'step', content: '想' }],
        timestamp: Date.now() - 2000,
      },
    ]
    render(<MessageCard sections={sections} isStreaming />)
    expect(screen.getByText(/\d+s/)).toBeInTheDocument()
    expect(screen.queryByText(/\d+\.\d+s/)).not.toBeInTheDocument()
  })
})

describe('MessageCard sub_agent 委派步骤', () => {
  it('sub_agent 收进父工具节点，渲染 DelegationBlock（内层无第二个时间线节点）', () => {
    const sections: MessageSection[] = [
      {
        type: 'tool_group',
        tools: [tool('call_helper', { params: '{"task":"查汇率"}' })],
        timestamp: ts,
      },
      {
        type: 'sub_agent',
        items: {
          agent_id: 'agent_sub',
          agent_name: '汇率助手',
          execution_id: 'SAEX_1',
          parent_call_id: 'call_call_helper',
          status: 'completed',
          result_summary: 'USD/CNY 7.15',
          sections: [
            {
              type: 'reason',
              items: [{ itemType: 'step', content: '子 agent 思考' }],
              timestamp: ts,
            },
            { type: 'content', content: 'USD/CNY 7.15', timestamp: ts },
          ],
        },
        timestamp: ts,
      },
      { type: 'content', content: '今日汇率 7.15', timestamp: ts },
    ]
    const { container } = render(<MessageCard sections={sections} />)
    // 外层只有一个折叠区；父工具与委派共用一个时间线节点。
    expect(screen.getAllByText('过程已完成')).toHaveLength(1)
    fireEvent.click(foldHead())
    const parent = screen.getByText('call_helper').closest('button')
    const child = screen.getByText('委派 · 汇率助手').closest('button')
    expect(parent).not.toBeNull()
    expect(child).not.toBeNull()
    expect(parent).not.toContainElement(child)
    expect(parent?.closest('li')).toContainElement(child)
    expect(container.querySelectorAll('ol > li')).toHaveLength(1)
    expect(screen.getByText('委派', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getAllByText('成功')).toHaveLength(2)
    expect(screen.getByText('今日汇率 7.15')).toBeInTheDocument()
  })

  it('子 Agent 等待确认时，父工具节点保持为当前步骤', () => {
    const sections: MessageSection[] = [
      { type: 'tool_group', tools: [tool('call_helper')], timestamp: ts },
      {
        type: 'sub_agent',
        items: {
          agent_id: 'agent_sub',
          agent_name: '研究助手',
          execution_id: 'SAEX_2',
          parent_call_id: 'call_call_helper',
          status: 'awaiting_user',
          sections: [],
        },
        timestamp: ts,
      },
    ]

    render(<MessageCard sections={sections} />)
    const process = screen.getByRole('group', { name: /等待确认/ })
    const parentItem = within(process).getByText('call_helper').closest('li')
    expect(parentItem).toHaveAttribute('aria-current', 'step')
    expect(within(process).getAllByRole('listitem')).toHaveLength(1)
  })
})
