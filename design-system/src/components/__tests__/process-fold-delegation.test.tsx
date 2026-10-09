import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DelegationBlock } from '../DelegationBlock'
import { ProcessFold } from '../ProcessFold'

describe('ProcessFold 子 Agent 委派层级', () => {
  it('父工具与子委派共用一个时间线步骤，且保持两个独立 disclosure', () => {
    const { container } = render(
      <ProcessFold
        status="running"
        defaultExpanded
        steps={[
          {
            kind: 'tool',
            state: 'active',
            tool: {
              name: 'call_helper',
              callId: 'call_1',
              label: '日志分析',
              status: 'running',
              params: '{"task":"定位错误"}',
            },
            subAgent: (
              <DelegationBlock
                agentName="日志分析"
                status="running"
                summary="正在定位错误"
                items={[{ itemType: 'step', content: '读取最近的错误日志。' }]}
              />
            ),
          },
        ]}
      />
    )

    const timeline = container.querySelector('ol')
    expect(timeline).not.toBeNull()
    expect(within(timeline as HTMLOListElement).getAllByRole('listitem')).toHaveLength(1)

    const parentDisclosure = screen.getByRole('button', { name: /call_helper.*委派/ })
    const childDisclosure = screen.getByRole('button', { name: /委派 · 日志分析/ })
    const timelineItem = parentDisclosure.closest('li')

    expect(timelineItem).toContainElement(childDisclosure)
    expect(parentDisclosure).not.toContainElement(childDisclosure)
    expect(screen.getByRole('group', { name: 'call_helper 的委派任务' })).toContainElement(
      childDisclosure
    )
  })

  it('没有父工具的委派仍可作为独立时间线步骤展示', () => {
    const { container } = render(
      <ProcessFold
        status="completed"
        defaultExpanded
        steps={[
          {
            kind: 'sub_agent',
            subAgent: (
              <DelegationBlock
                agentName="历史子任务"
                status="completed"
                summary="旧数据缺少父调用 ID"
                items={[]}
              />
            ),
          },
        ]}
      />
    )

    expect(container.querySelectorAll('ol > li')).toHaveLength(1)
    expect(screen.getByText('委派 · 历史子任务')).toBeInTheDocument()
  })
})
