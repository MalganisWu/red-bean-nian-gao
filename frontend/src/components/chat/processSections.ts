import type { ReasonItemDto } from '@red-bean/api-contract'
import type {
  DisplayMessageMeta,
  MessageSection,
  PersistedMessageSection,
  PersistedSubAgentSectionData,
  PersistedToolCard,
  ProcessStepItem,
  ReasonItem,
  SubAgentSectionData,
  ToolCard,
} from '@/types/chat'

/**
 * 思考过程折叠区收束（spec: process-fold-timeline §2/§6）：
 * 一轮 assistant 回合的 sections 收束为 `[process?, content?]`——
 * 除最终 content 外的一切（reason/tool_group/sub_agent/中间 content）先按到达时序
 * 收为 process 步骤，再按 callId / parent_call_id 把委派挂入父工具；card 作为
 * approval 节点留在同一条时间线，回答后的
 * 续跑步骤继续追加，不拆成第二个 process；最终 content 留在区外作正文。
 *
 * 流式中（isStreaming）无法预知谁是最终 content → 所有 content 一律进 process
 * 作 narration；回合结束后（isStreaming=false）最后一个 content 晋升出区。
 *
 * 纯渲染层收束：不动持久化数据，同一函数处理实时与历史 sections。
 *
 * @param sections - 待收束的消息 section 列表。
 * @param opts - 收束选项；`isStreaming` 决定末位 content 是否晋升出区。
 * @returns 收束后的 `[process?, content?]` section 列表。
 */
export function collapseToProcessFold(
  sections: MessageSection[],
  opts: { isStreaming: boolean }
): MessageSection[] {
  const { isStreaming } = opts
  // 只有真正位于回合末尾的 content 才是 Final。若其后还有工具或新确认，
  // 它只是过程叙述；尤其二次提问不能把一个 Process 从中间切开。
  const lastContentIdx =
    !isStreaming && sections.at(-1)?.type === 'content' ? sections.length - 1 : -1

  const out: MessageSection[] = []
  let pendingSteps: ProcessStepItem[] = []
  let pendingTs = 0

  /** 把已累积的步骤收束成一个 process section；没有步骤时不产出。 */
  function flushProcess(): void {
    if (pendingSteps.length === 0) return
    out.push({
      type: 'process',
      steps: attachSubAgentsToParents(pendingSteps),
      timestamp: pendingTs,
    })
    pendingSteps = []
    pendingTs = 0
  }

  /** 追加一个过程步骤；稳定业务 ID 重复的节点只保留一次。 */
  function pushStep(step: ProcessStepItem, ts: number): void {
    // answer 续跑期间，已收束的 process 与原始 card 会短暂同时存在。
    // 稳定业务 ID 相同的节点只保留一次，避免确认卡片重复渲染。
    if (
      (step.kind === 'approval' &&
        step.approval &&
        pendingSteps.some(
          (current) =>
            current.kind === 'approval' &&
            current.approval?.interaction_id === step.approval?.interaction_id
        )) ||
      (step.kind === 'tool' &&
        step.tool &&
        pendingSteps.some(
          (current) => current.kind === 'tool' && current.tool?.callId === step.tool?.callId
        )) ||
      (step.kind === 'sub_agent' &&
        step.subAgent &&
        pendingSteps.some(
          (current) =>
            current.kind === 'sub_agent' &&
            current.subAgent?.execution_id === step.subAgent?.execution_id
        ))
    ) {
      return
    }
    if (pendingSteps.length === 0) pendingTs = ts
    pendingSteps.push(step)
  }

  for (const [i, s] of sections.entries()) {
    switch (s.type) {
      case 'reason':
        for (const item of s.items) {
          if (item.itemType === 'tool' && item.tool) {
            pushStep({ kind: 'tool', tool: item.tool }, s.timestamp)
          } else if (item.content) {
            pushStep({ kind: 'think', content: item.content }, s.timestamp)
          }
        }
        break
      case 'tool_group':
        for (const t of s.tools) pushStep({ kind: 'tool', tool: t }, s.timestamp)
        break
      case 'sub_agent':
        pushStep({ kind: 'sub_agent', subAgent: s.items }, s.timestamp)
        break
      case 'content':
        if (i === lastContentIdx) {
          // 最终回答晋升出区
          flushProcess()
          out.push(s)
        } else {
          pushStep({ kind: 'narration', content: s.content }, s.timestamp)
        }
        break
      case 'card':
        // 确认是当前过程中的一个节点。pending 时由 ProcessFold 保证折叠后仍常显。
        pushStep({ kind: 'approval', approval: s.card }, s.timestamp)
        break
      case 'process':
        // Runtime checkpoint 与任务执行记录可以直接持久化已经收束好的 process。
        // 渲染入口必须展开并重新收束这些步骤，否则执行详情会只剩最终回答。
        for (const step of s.steps) pushStep(step, s.timestamp)
        break
    }
  }
  flushProcess()
  return out
}

/**
 * 在完整 Process 内按稳定 ID 建立委派关系，不依赖工具名称、Agent 名称或相邻顺序。
 * 缺失/错误 parent_call_id 与重复数据保持独立步骤，避免旧历史内容丢失。
 */
function attachSubAgentsToParents(steps: ProcessStepItem[]): ProcessStepItem[] {
  const grouped = steps.map((step) => ({ ...step }))
  const toolIndexByCallID = new Map<string, number>()
  const attachedSubAgentIndexes = new Set<number>()

  /** 记录每个 callId 首次出现的工具步骤下标。 */
  function collectToolIndex(step: ProcessStepItem, index: number): void {
    if (step.kind === 'tool' && step.tool?.callId && !toolIndexByCallID.has(step.tool.callId)) {
      toolIndexByCallID.set(step.tool.callId, index)
    }
  }

  /** 把子 Agent 步骤挂到其父工具上，并记下被挂载的下标以便随后剔除。 */
  function attachSubAgentToParent(step: ProcessStepItem, index: number): void {
    if (step.kind !== 'sub_agent' || !step.subAgent?.parent_call_id) return
    const parentIndex = toolIndexByCallID.get(step.subAgent.parent_call_id)
    if (parentIndex === undefined) return

    const parent = grouped[parentIndex]
    if (!parent || parent.kind !== 'tool' || parent.subAgent) return
    grouped[parentIndex] = { ...parent, subAgent: step.subAgent }
    attachedSubAgentIndexes.add(index)
  }

  grouped.forEach(collectToolIndex)
  grouped.forEach(attachSubAgentToParent)

  return grouped.filter((_, index) => !attachedSubAgentIndexes.has(index))
}

/**
 * 回合总耗时（毫秒，包络公式）：max(section 结束) − 回合开始。
 * 起点 = meta.run_started_at（后端首事件打点，含首轮 LLM TTFB）；
 * 旧数据无此字段时回退到最早 section 时间戳。
 * ts=0 的 section（如持久化的 sub_agent）过滤；全部无效时返回 undefined（不显示）。
 *
 * @param sections - 本回合的消息 section 列表。
 * @param meta - 回合元信息；`run_started_at` 作为耗时起点，缺失时回退到最早 section 时间戳。
 * @returns 回合总耗时（毫秒）；无有效时间戳时返回 `undefined`（调用方据此隐藏耗时）。
 */
export function roundTotalDurationMs(
  sections: MessageSection[],
  meta?: DisplayMessageMeta
): number | undefined {
  let minTs = Infinity
  let maxEnd = -Infinity
  for (const s of sections) {
    const ts = s.timestamp
    if (!ts || ts <= 0) continue
    minTs = Math.min(minTs, ts)
    const dur = 'duration' in s && typeof s.duration === 'number' ? s.duration : 0
    maxEnd = Math.max(maxEnd, ts + dur)
  }
  if (minTs === Infinity) return undefined
  const start = meta?.run_started_at && meta.run_started_at > 0 ? meta.run_started_at : minTs
  return Math.max(0, maxEnd - start)
}

/**
 * 毫秒 → "12s" 展示格式（耗时显示唯一出口；最低显示 1s，避免小数秒跳动）
 *
 * @param ms - 耗时毫秒数；负数按 0 处理。
 * @returns 形如 `"12s"` 的展示字符串，最小为 `"1s"`。
 */
export function formatDurationMs(ms: number): string {
  return `${Math.max(1, Math.round(Math.max(0, ms) / 1000))}s`
}

/**
 * 工具耗时显示口径：durationMs（数值）优先，回退旧字符串 duration；都无则不显示
 *
 * @param t - 工具卡片；`durationMs` 为新字段，`duration` 为旧数据回落。
 * @returns 格式化后的耗时文案；两者都缺失时返回 `undefined`（调用方据此隐藏）。
 */
export function toolDurationLabel(t: ToolCard): string | undefined {
  if (typeof t.durationMs === 'number') return formatDurationMs(t.durationMs)
  if (!t.duration) return undefined
  const legacySeconds = t.duration.match(/^\s*<?\s*(\d+(?:\.\d+)?)\s*(?:s|秒)\s*$/i)
  return legacySeconds ? `${Math.max(1, Math.round(Number(legacySeconds[1])))}s` : t.duration
}

/**
 * 历史透传归一化：持久化 JSON 里工具耗时字段是 `duration`（毫秒数值，引擎 Task 1 起写入），
 * 运行时统一用 `durationMs`。加载历史会话时转换；旧数据无该字段则 durationMs 保持 undefined。
 * sub_agent 嵌套 sections 递归处理。
 *
 * @param sections - 从持久化 JSON 读出的 section 列表。
 * @returns 归一化后的运行时 section 列表；旧数据无耗时字段时 `durationMs` 保持 `undefined`。
 */
export function normalizePersistedSections(
  sections: readonly PersistedMessageSection[]
): MessageSection[] {
  return sections.map(normalizePersistedSection)
}

/** 归一化单个持久化 section：转换工具耗时字段并递归处理子 Agent 内层 sections。 */
function normalizePersistedSection(s: PersistedMessageSection): MessageSection {
  if (s.type === 'tool_group') {
    return { ...s, tools: s.tools.map(normalizeTool) }
  }
  if (s.type === 'reason') {
    return {
      ...s,
      items: s.items.map(normalizeReasonItem),
    }
  }
  if (s.type === 'sub_agent') {
    return {
      ...s,
      items: normalizeSubAgent(s.items),
    }
  }
  return s
}

function normalizeReasonItem(item: ReasonItemDto): ReasonItem {
  return {
    itemType: item.itemType,
    index: item.index,
    content: item.content,
    tool: item.tool ? normalizeTool(item.tool) : undefined,
  }
}

function normalizeSubAgent(data: PersistedSubAgentSectionData): SubAgentSectionData {
  return {
    ...data,
    status: data.status === 'running' ? ('incomplete' as const) : data.status,
    sections: normalizePersistedSections(data.sections ?? []),
  }
}

function normalizeTool(t: PersistedToolCard): ToolCard {
  const persisted: unknown = t.duration
  const status: ToolCard['status'] = t.status === 'running' ? 'incomplete' : t.status
  return {
    ...t,
    status,
    duration: typeof persisted === 'string' ? persisted : undefined,
    durationMs: typeof persisted === 'number' ? persisted : t.durationMs,
    startedAtMs: t.status === 'running' ? undefined : t.startedAtMs,
  }
}
