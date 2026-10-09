import { describe, it, expect, vi } from 'vitest'
import {
  applyToken,
  applyReasonStep,
  applyToolStart,
  applyToolResult,
  applyToolFail,
  settleIncompleteTools,
} from '@/components/chat/streamSections'
import type { MessageSection } from '@/types/chat'

// streamSections：chat-store 实时组装逻辑的纯函数抽取——
// 主消息 pendingSections 与子 agent 内层 sections 共用同一套组装语义。
describe('streamSections 纯函数组装', () => {
  it('applyToken：追加到最后 content，否则新建', () => {
    const s0: MessageSection[] = []
    const s1 = applyToken(s0, '你')
    expect(s1).toMatchObject([{ type: 'content', content: '你' }])
    expect(typeof s1[0]?.timestamp).toBe('number')
    const s2 = applyToken(s1, '好')
    expect(s2).toHaveLength(1)
    expect(s2[0]).toMatchObject({ content: '你好' })
    // 最后一段是 reason 时新建 content 段
    const s3 = applyToken(
      [{ type: 'reason', items: [{ itemType: 'step', index: 1, content: '想' }], timestamp: 1 }],
      '答'
    )
    expect(s3).toHaveLength(2)
    expect(s3[1]).toMatchObject({ type: 'content', content: '答' })
  })

  it('applyReasonStep：同步骤号合并；接 tool_group 时收编为 reason', () => {
    const s1 = applyReasonStep([], 1, '分析')
    const s2 = applyReasonStep(s1, 1, '中')
    expect(s2).toHaveLength(1)
    expect(s2[0]).toMatchObject({ items: [{ itemType: 'step', index: 1, content: '分析中' }] })
    // tool_group → reason：工具转 item 在前
    const s3 = applyReasonStep(
      [
        {
          type: 'tool_group',
          tools: [{ callId: 'c1', name: 't', status: 'success' }],
          timestamp: 1,
        },
      ],
      2,
      '继续想'
    )
    expect(s3).toHaveLength(1)
    expect(s3[0]).toMatchObject({
      type: 'reason',
      items: [
        { itemType: 'tool', tool: { callId: 'c1' } },
        { itemType: 'step', index: 2, content: '继续想' },
      ],
    })
  })

  it('applyToolStart：接 reason 进 items，接 tool_group 进 tools，否则新建 tool_group', () => {
    const withReason = applyToolStart(
      [{ type: 'reason', items: [{ itemType: 'step', index: 1, content: '想' }], timestamp: 1 }],
      'c1',
      'search'
    )
    expect(withReason[0]).toMatchObject({
      type: 'reason',
      items: [
        { itemType: 'step' },
        { itemType: 'tool', tool: { callId: 'c1', name: 'search', status: 'running' } },
      ],
    })
    const fresh = applyToolStart([], 'c2', 'calc', { expression: '1 + 2', precision: 2 })
    expect(fresh[0]).toMatchObject({
      type: 'tool_group',
      tools: [
        {
          callId: 'c2',
          status: 'running',
          params: '{"expression":"1 + 2","precision":2}',
        },
      ],
    })
  })

  it('applyToolResult / applyToolFail：按 callId 落定 tool_group 与 reason 内嵌工具', () => {
    const base: MessageSection[] = [
      {
        type: 'reason',
        items: [{ itemType: 'tool', tool: { callId: 'c1', name: 'a', status: 'running' } }],
        timestamp: 1,
      },
      { type: 'tool_group', tools: [{ callId: 'c2', name: 'b', status: 'running' }], timestamp: 1 },
    ]
    const ok = applyToolResult(base, 'c2', 'done')
    expect((ok[1] as { tools: { status: string; result: string }[] }).tools[0]).toMatchObject({
      status: 'success',
      result: 'done',
    })
    const failed = applyToolFail(base, 'c1', 'boom')
    const items = (failed[0] as { items: { tool?: { status: string; error: string } }[] }).items
    expect(items[0].tool).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('不可变：输入数组与 section 不被修改', () => {
    const base: MessageSection[] = [{ type: 'content', content: 'a', timestamp: 1 }]
    const snapshot = JSON.stringify(base)
    applyToken(base, 'b')
    applyReasonStep(base, 1, 'x')
    applyToolStart(base, 'c1', 't')
    expect(JSON.stringify(base)).toBe(snapshot)
  })
})

// ── durationMs：单工具耗时（live 计时） ──────────────
// spec: process-fold-timeline §4——live 按 call_id 各自计时（tool_start→tool_result）。

describe('工具耗时 durationMs（live）', () => {
  it('applyToolStart 打点 startedAtMs；applyToolResult 结算 durationMs 并清除打点', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10000)
      const s = applyToolStart([], 'c1', 'calc')
      const started = (s[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
      expect(started.startedAtMs).toBe(10000)

      vi.setSystemTime(11500)
      const done = applyToolResult(s, 'c1', 'ok')
      const tool = (done[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
      expect(tool.durationMs).toBe(1500)
      expect(tool.startedAtMs).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('并发批次各算各的：c2 晚结束 durationMs 更大', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      let s = applyToolStart([], 'c1', 'a')
      s = applyToolStart(s, 'c2', 'b')
      vi.setSystemTime(1000)
      s = applyToolResult(s, 'c1', 'ok')
      vi.setSystemTime(2500)
      s = applyToolResult(s, 'c2', 'ok')
      const tools = (s[0] as Extract<MessageSection, { type: 'tool_group' }>).tools
      expect(tools[0].durationMs).toBe(1000)
      expect(tools[1].durationMs).toBe(2500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applyToolFail 同样结算 durationMs', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(5000)
      const s = applyToolStart([], 'c1', 'broken')
      vi.setSystemTime(5300)
      const failed = applyToolFail(s, 'c1', 'boom')
      const tool = (failed[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
      expect(tool.durationMs).toBe(300)
      expect(tool.status).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('结束时递归结算主流程与子 Agent 的 running Tool，并清除计时打点', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      const sections: MessageSection[] = [
        ...applyToolStart([], 'main', 'main_tool'),
        {
          type: 'sub_agent',
          items: {
            agent_id: 'sub',
            agent_name: '子任务',
            execution_id: 'exec',
            status: 'running',
            sections: applyToolStart([], 'inner', 'inner_tool'),
          },
          timestamp: 1000,
        },
      ]

      vi.setSystemTime(1800)
      const settled = settleIncompleteTools(sections)
      const main = (settled[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]
      const sub = (settled[1] as Extract<MessageSection, { type: 'sub_agent' }>).items
      const inner = (sub.sections[0] as Extract<MessageSection, { type: 'tool_group' }>).tools[0]

      expect(main).toMatchObject({ status: 'incomplete', durationMs: 800 })
      expect(main.startedAtMs).toBeUndefined()
      expect(inner).toMatchObject({ status: 'incomplete', durationMs: 800 })
      expect(inner.startedAtMs).toBeUndefined()
      expect(sub.status).toBe('incomplete')
    } finally {
      vi.useRealTimers()
    }
  })

  it('结束时结算 process 父工具内嵌的 sub_agent', () => {
    const sections: MessageSection[] = [
      {
        type: 'process',
        timestamp: 1000,
        steps: [
          {
            kind: 'tool',
            tool: { callId: 'parent', name: 'call_helper', status: 'running' },
            subAgent: {
              agent_id: 'sub',
              agent_name: '子任务',
              execution_id: 'exec',
              parent_call_id: 'parent',
              status: 'running',
              sections: [],
            },
          },
        ],
      },
    ]

    const settled = settleIncompleteTools(sections)
    const step = (settled[0] as Extract<MessageSection, { type: 'process' }>).steps[0]
    expect(step.tool?.status).toBe('incomplete')
    expect(step.subAgent?.status).toBe('incomplete')
  })
})
