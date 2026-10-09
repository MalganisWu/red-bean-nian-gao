import { describe, it, expect } from 'vitest'
import { normalizeSections } from '@/components/chat/messageSections'
import type { MessageSection, ToolCard } from '@/types/chat'

const tool = (name: string): ToolCard => ({ callId: `call_${name}`, name, status: 'success' })
const step = (content: string) => ({ itemType: 'step' as const, content })
const ts = 100

const reason = (...contents: string[]): MessageSection => ({
  type: 'reason',
  items: contents.map(step),
  timestamp: ts,
})
const toolGroup = (...names: string[]): MessageSection => ({
  type: 'tool_group',
  tools: names.map(tool),
  timestamp: ts,
})
const content = (text: string): MessageSection => ({
  type: 'content',
  content: text,
  timestamp: ts,
})

type ProcessSection = Extract<MessageSection, { type: 'process' }>
const processSteps = (s: MessageSection) => (s as ProcessSection).steps

// normalizeSections 是 MessageCard 渲染入口，委托 collapseToProcessFold（spec §2/§6）。
// 核心收束规则由 processSections.test.ts 覆盖；这里锁「渲染入口的输出形态」。
describe('normalizeSections：渲染入口输出 [process?, content?] 模型', () => {
  it('保留任务执行记录中已经持久化的 process 步骤', () => {
    const out = normalizeSections([
      {
        type: 'process',
        timestamp: 1,
        steps: [
          { kind: 'think', content: '检查任务上下文' },
          {
            kind: 'tool',
            tool: { callId: 'call-1', name: 'clock', status: 'success' },
          },
        ],
      },
      content('执行完成'),
    ])

    expect(out).toEqual([
      {
        type: 'process',
        timestamp: 1,
        steps: [
          { kind: 'think', content: '检查任务上下文' },
          {
            kind: 'tool',
            tool: { callId: 'call-1', name: 'clock', status: 'success' },
          },
        ],
      },
      content('执行完成'),
    ])
  })

  it('合并续跑数据时不重复 process 中已有的确认节点', () => {
    const approval = {
      interaction_id: 'ask-1',
      status: 'answered' as const,
      questions: [{ id: 'scope', text: '继续吗？' }],
    }
    const out = normalizeSections([
      {
        type: 'process',
        timestamp: 1,
        steps: [{ kind: 'approval', approval }],
      },
      { type: 'card', timestamp: 2, card: approval },
    ])

    expect(out).toHaveLength(1)
    expect((out[0] as ProcessSection).steps).toHaveLength(1)
  })

  it('过程 sections（reason/tool_group/中间 content）收进 process 步骤，最终 content 留外层', () => {
    const out = normalizeSections([
      reason('要查天气'),
      content('我查一下'),
      toolGroup('search'),
      content('今天晴'),
    ])
    expect(out.map((s) => s.type)).toEqual(['process', 'content'])
    expect(processSteps(out[0]).map((s) => s.kind)).toEqual(['think', 'narration', 'tool'])
    expect(out[1].type === 'content' && out[1].content).toBe('今天晴')
  })

  it('流式中：全部 content（含最终候选）进 process 作 narration', () => {
    const out = normalizeSections([reason('想'), content('正在流出')], { isStreaming: true })
    expect(out.map((s) => s.type)).toEqual(['process'])
    expect(processSteps(out[0]).map((s) => s.kind)).toEqual(['think', 'narration'])
  })

  it('card 作为 approval 节点留在同一 process', () => {
    const card: MessageSection = {
      type: 'card',
      card: { interaction_id: 'x', status: 'pending', questions: [] },
      timestamp: ts,
    }
    const out = normalizeSections([reason('想'), card, toolGroup('a'), content('答')])
    expect(out.map((s) => s.type)).toEqual(['process', 'content'])
    expect(processSteps(out[0]).map((s) => s.kind)).toEqual(['think', 'approval', 'tool'])
  })

  it('sub_agent 收为 process 内的一个步骤（不嵌套折叠区）', () => {
    const sub: MessageSection = {
      type: 'sub_agent',
      items: {
        agent_id: 'a1',
        agent_name: '子',
        execution_id: 'SAEX_1',
        sections: [],
        status: 'completed',
      },
      timestamp: ts,
    }
    const out = normalizeSections([reason('委派前'), sub, content('答')])
    expect(out.map((s) => s.type)).toEqual(['process', 'content'])
    expect(processSteps(out[0]).map((s) => s.kind)).toEqual(['think', 'sub_agent'])
  })

  it('纯 content 回合：无过程则不产生折叠区', () => {
    const out = normalizeSections([content('直接回答')])
    expect(out.map((s) => s.type)).toEqual(['content'])
  })
})
