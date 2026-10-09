import { describe, it, expect } from 'vitest'
import {
  collapseToProcessFold,
  roundTotalDurationMs,
  normalizePersistedSections,
  toolDurationLabel,
} from './processSections'
import type {
  MessageSection,
  PersistedMessageSection,
  ToolCard,
  SubAgentSectionData,
} from '@/types/chat'

const tool = (name: string, extra?: Partial<ToolCard>): ToolCard => ({
  callId: `call_${name}`,
  name,
  status: 'success',
  ...extra,
})

const subAgentData = (name: string, parentCallId?: string): SubAgentSectionData => ({
  agent_id: `agent_${name}`,
  agent_name: name,
  execution_id: `SAEX_${name}`,
  sections: [],
  status: 'completed',
  parent_call_id: parentCallId,
})

describe('collapseToProcessFold：sections → [process?, content?]', () => {
  it('sub_agent 按 parent_call_id 归入父工具，最终 content 留外层', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想一想' }], timestamp: 100 },
      { type: 'tool_group', tools: [tool('a'), tool('b')], timestamp: 200 },
      { type: 'content', content: '中间叙述', timestamp: 300 },
      { type: 'sub_agent', items: subAgentData('calc_helper', 'call_b'), timestamp: 400 },
      { type: 'content', content: '最终回答', timestamp: 500 },
    ]
    const out = collapseToProcessFold(sections, { isStreaming: false })
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('process')
    expect(out[1]).toEqual({ type: 'content', content: '最终回答', timestamp: 500 })

    const steps = (out[0] as Extract<MessageSection, { type: 'process' }>).steps
    expect(steps.map((s) => s.kind)).toEqual(['think', 'tool', 'tool', 'narration'])
    expect(steps[0].content).toBe('想一想')
    expect(steps[1].tool?.name).toBe('a')
    expect(steps[2].tool?.name).toBe('b')
    expect(steps[3].content).toBe('中间叙述')
    expect(steps[2].subAgent?.agent_name).toBe('calc_helper')
  })

  it('parent_call_id 缺失或匹配不到工具时保留独立 sub_agent 步骤', () => {
    const missing = subAgentData('missing')
    const unmatched = subAgentData('unmatched', 'call_unknown')
    const out = collapseToProcessFold(
      [
        { type: 'tool_group', tools: [tool('a')], timestamp: 100 },
        { type: 'sub_agent', items: missing, timestamp: 200 },
        { type: 'sub_agent', items: unmatched, timestamp: 300 },
      ],
      { isStreaming: false }
    )

    const steps = (out[0] as Extract<MessageSection, { type: 'process' }>).steps
    expect(steps.map((step) => step.kind)).toEqual(['tool', 'sub_agent', 'sub_agent'])
    expect(steps[1].subAgent).toBe(missing)
    expect(steps[2].subAgent).toBe(unmatched)
  })

  it('流式中：全部 content（含流出中的）进 process 作 narration', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想' }], timestamp: 100 },
      { type: 'content', content: '正在流出的文字', timestamp: 200 },
    ]
    const out = collapseToProcessFold(sections, { isStreaming: true })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('process')
    const steps = (out[0] as Extract<MessageSection, { type: 'process' }>).steps
    expect(steps.map((s) => s.kind)).toEqual(['think', 'narration'])
  })

  it('card 成为 approval 节点，前后步骤保持在同一个 process', () => {
    const card: MessageSection = {
      type: 'card',
      card: { interaction_id: 'ix1', status: 'pending', questions: [] },
      timestamp: 200,
    }
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '前' }], timestamp: 100 },
      card,
      { type: 'tool_group', tools: [tool('a')], timestamp: 300 },
      { type: 'content', content: '最终回答', timestamp: 400 },
    ]
    const out = collapseToProcessFold(sections, { isStreaming: false })
    expect(out.map((s) => s.type)).toEqual(['process', 'content'])
    const steps = (out[0] as Extract<MessageSection, { type: 'process' }>).steps
    expect(steps.map((s) => s.kind)).toEqual(['think', 'approval', 'tool'])
    expect(steps[1].approval).toEqual(card.card)
  })

  it('二次提问前的 content 仍是过程叙述，不会拆成两个 process', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '开始处理' }], timestamp: 100 },
      {
        type: 'card',
        card: { interaction_id: 'a', status: 'answered', questions: [], answers: {} },
        timestamp: 200,
      },
      { type: 'content', content: '还需要确认一个范围', timestamp: 300 },
      {
        type: 'card',
        card: { interaction_id: 'b', status: 'pending', questions: [] },
        timestamp: 400,
      },
    ]

    const out = collapseToProcessFold(sections, { isStreaming: false })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('process')
    const steps = (out[0] as Extract<MessageSection, { type: 'process' }>).steps
    expect(steps.map((step) => step.kind)).toEqual(['think', 'approval', 'narration', 'approval'])
  })

  it('多次确认后的续跑仍只有一个 process，末尾 content 才成为 Final', () => {
    const sections: MessageSection[] = [
      {
        type: 'card',
        card: { interaction_id: 'a', status: 'answered', questions: [], answers: {} },
        timestamp: 100,
      },
      { type: 'content', content: '准备第二步', timestamp: 200 },
      {
        type: 'card',
        card: { interaction_id: 'b', status: 'answered', questions: [], answers: {} },
        timestamp: 300,
      },
      { type: 'reason', items: [{ itemType: 'step', content: '完成处理' }], timestamp: 400 },
      { type: 'content', content: '最终回答', timestamp: 500 },
    ]

    const out = collapseToProcessFold(sections, { isStreaming: false })
    expect(out.map((section) => section.type)).toEqual(['process', 'content'])
    const steps = (out[0] as Extract<MessageSection, { type: 'process' }>).steps
    expect(steps.map((step) => step.kind)).toEqual(['approval', 'narration', 'approval', 'think'])
  })

  it('纯回答回合：无过程 section，不产生空折叠区', () => {
    const sections: MessageSection[] = [{ type: 'content', content: '直接回答', timestamp: 100 }]
    const out = collapseToProcessFold(sections, { isStreaming: false })
    expect(out).toEqual(sections)
  })

  it('无最终 content（出错/取消回合）：全部进 process，不凭空造 content', () => {
    const sections: MessageSection[] = [
      { type: 'reason', items: [{ itemType: 'step', content: '想' }], timestamp: 100 },
      { type: 'tool_group', tools: [tool('a', { status: 'failed', error: 'x' })], timestamp: 200 },
    ]
    const out = collapseToProcessFold(sections, { isStreaming: false })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('process')
  })

  it('reason 内嵌的 tool item 也平铺为 tool 步骤（时序保持）', () => {
    const sections: MessageSection[] = [
      {
        type: 'reason',
        items: [
          { itemType: 'step', content: '想' },
          { itemType: 'tool', tool: tool('inner') },
        ],
        timestamp: 100,
      },
      { type: 'content', content: '答', timestamp: 200 },
    ]
    const out = collapseToProcessFold(sections, { isStreaming: false })
    const steps = (out[0] as Extract<MessageSection, { type: 'process' }>).steps
    expect(steps.map((s) => s.kind)).toEqual(['think', 'tool'])
    expect(steps[1].tool?.name).toBe('inner')
  })
})

describe('roundTotalDurationMs：回合总耗时（包络公式）', () => {
  const sections: MessageSection[] = [
    { type: 'reason', items: [{ itemType: 'step', content: 'x' }], timestamp: 1000, duration: 600 },
    { type: 'tool_group', tools: [tool('a')], timestamp: 1700, duration: 3000 },
    { type: 'content', content: '答', timestamp: 4800, duration: 150 },
  ]

  it('有 run_started_at：max(ts+dur) − run_started_at', () => {
    expect(roundTotalDurationMs(sections, { run_started_at: 900 })).toBe(4950 - 900)
  })

  it('无 run_started_at（旧数据）：回退到 min(section ts)', () => {
    expect(roundTotalDurationMs(sections, undefined)).toBe(4950 - 1000)
    expect(roundTotalDurationMs(sections, {})).toBe(4950 - 1000)
  })

  it('sub_agent ts=0 被过滤，不拉歪起点', () => {
    const withSub: MessageSection[] = [
      { type: 'sub_agent', items: subAgentData('x'), timestamp: 0 },
      ...sections,
    ]
    expect(roundTotalDurationMs(withSub, undefined)).toBe(4950 - 1000)
  })

  it('全部无有效时间戳：返回 undefined（不显示）', () => {
    const broken: MessageSection[] = [{ type: 'sub_agent', items: subAgentData('x'), timestamp: 0 }]
    expect(roundTotalDurationMs(broken, undefined)).toBeUndefined()
  })
})

describe('normalizePersistedSections：历史透传（持久化 duration → durationMs）', () => {
  it('tool_group 工具的持久化 duration(ms) 转 durationMs，原字段移除', () => {
    const raw = [
      {
        type: 'tool_group',
        tools: [{ callId: 'c1', name: 'calc', status: 'success', result: '42', duration: 1234 }],
        timestamp: 100,
      },
    ] as unknown as PersistedMessageSection[]
    const out = normalizePersistedSections(raw)
    const t = (out[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
    expect(t.durationMs).toBe(1234)
    expect(t.duration).toBeUndefined()
  })

  it('reason 内嵌工具 + sub_agent 嵌套 sections 递归处理', () => {
    const raw = [
      {
        type: 'reason',
        items: [
          { itemType: 'tool', tool: { callId: 'c1', name: 'a', status: 'success', duration: 500 } },
        ],
        timestamp: 100,
      },
      {
        type: 'sub_agent',
        items: {
          agent_id: 'agent_x',
          agent_name: 'x',
          execution_id: 'SAEX_1',
          status: 'completed',
          sections: [
            {
              type: 'tool_group',
              tools: [{ callId: 'c2', name: 'b', status: 'success', duration: 88 }],
              timestamp: 200,
            },
          ],
        },
        timestamp: 0,
      },
    ] as unknown as PersistedMessageSection[]
    const out = normalizePersistedSections(raw)
    const inner = (out[0] as Extract<MessageSection, { type: 'reason' }>).items[0]
    expect(inner.tool?.durationMs).toBe(500)
    const sub = (out[1] as Extract<MessageSection, { type: 'sub_agent' }>).items
    const subTool = (sub.sections[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
    expect(subTool.durationMs).toBe(88)
  })

  it('旧数据无 duration 字段：durationMs 保持 undefined（降级不显示）', () => {
    const raw = [
      {
        type: 'tool_group',
        tools: [{ callId: 'c1', name: 'a', status: 'success' }],
        timestamp: 100,
      },
    ] as unknown as PersistedMessageSection[]
    const out = normalizePersistedSections(raw)
    const t = (out[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
    expect(t.durationMs).toBeUndefined()
  })

  it('历史遗留 running 递归归一化为 incomplete，不再显示为仍在运行', () => {
    const raw: PersistedMessageSection[] = [
      {
        type: 'tool_group',
        tools: [{ callId: 'c1', name: 'main', status: 'running', startedAtMs: 1 }],
        timestamp: 100,
      },
      {
        type: 'sub_agent',
        items: {
          agent_id: 'agent_x',
          agent_name: 'x',
          execution_id: 'SAEX_1',
          status: 'running',
          sections: [
            {
              type: 'tool_group',
              tools: [{ callId: 'c2', name: 'inner', status: 'running' }],
              timestamp: 200,
            },
          ],
        },
        timestamp: 100,
      },
    ]

    const out = normalizePersistedSections(raw)
    const main = (out[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
    const sub = (out[1] as Extract<MessageSection, { type: 'sub_agent' }>).items
    const inner = (sub.sections[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]

    expect(main.status).toBe('incomplete')
    expect(main.startedAtMs).toBeUndefined()
    expect(sub.status).toBe('incomplete')
    expect(inner.status).toBe('incomplete')
  })
})

describe('toolDurationLabel：工具耗时显示口径（唯一出口）', () => {
  it('durationMs 优先，格式化为整数秒且最低显示 1s', () => {
    expect(toolDurationLabel(tool('a', { durationMs: 1234 }))).toBe('1s')
    expect(toolDurationLabel(tool('a', { durationMs: 50 }))).toBe('1s')
  })

  it('旧字符串 duration 中的小数秒也归一为整数；都无则 undefined（不显示）', () => {
    expect(toolDurationLabel(tool('a', { duration: '2s' }))).toBe('2s')
    expect(toolDurationLabel(tool('a', { duration: '2.4s' }))).toBe('2s')
    expect(toolDurationLabel(tool('a', { duration: '2.6 秒' }))).toBe('3s')
    expect(toolDurationLabel(tool('a'))).toBeUndefined()
  })
})
