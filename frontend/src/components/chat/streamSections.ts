import type {
  MessageSection,
  ProcessStepItem,
  ReasonItem,
  SubAgentSectionData,
  ToolCard,
} from '@/types/chat'

// 流式 section 组装纯函数：从 chat-store 的实时组装动作抽取，
// 主消息 pendingSections 与子 agent 内层 sections（sub_agent section 的 items.sections）
// 共用同一套组装语义，保证「主流程什么样、子 agent 就什么样」。
//
// 全部不可变：返回新数组/新 section，输入不被修改。

/**
 * 追加一段正文增量：末位是 content 则就地拼接，否则新开一个 content section。
 *
 * @param sections - 组装中的 section 列表。
 * @param content - 本次到达的正文增量片段。
 * @returns 追加后的新 section 列表（不可变，输入不被修改）。
 */
export function applyToken(sections: MessageSection[], content: string): MessageSection[] {
  const last = sections[sections.length - 1]
  if (last && last.type === 'content') {
    return [...sections.slice(0, -1), { ...last, content: last.content + content }]
  }
  return [...sections, { type: 'content', content, timestamp: Date.now() }]
}

/**
 * 追加一段推理增量。
 * 与相邻 section 的合并规则：紧邻 reason 且步骤号相同 → 并入同一项；
 * 紧邻 tool_group → 把整组工具收进新的 reason section，以保持「思考 → 工具 → 继续思考」的时序。
 *
 * @param sections - 组装中的 section 列表。
 * @param step - 步骤号；与末位 reason 内最后一项相同时并入该项。
 * @param content - 本次到达的推理增量片段。
 * @returns 追加后的新 section 列表（不可变，输入不被修改）。
 */
export function applyReasonStep(
  sections: MessageSection[],
  step: number,
  content: string
): MessageSection[] {
  const last = sections[sections.length - 1]
  if (last && last.type === 'reason') {
    const lastItem = last.items[last.items.length - 1]
    const items =
      lastItem && lastItem.itemType === 'step' && lastItem.index === step
        ? // 同一步骤号合并
          [...last.items.slice(0, -1), { ...lastItem, content: (lastItem.content ?? '') + content }]
        : [...last.items, { itemType: 'step' as const, index: step, content }]
    return [...sections.slice(0, -1), { ...last, items }]
  }
  if (last && last.type === 'tool_group') {
    // tool→reason 合并：把已完成的工具组移入新 reason section
    const toolItems: ReasonItem[] = last.tools.map((t) => ({ itemType: 'tool', tool: t }))
    return [
      ...sections.slice(0, -1),
      {
        type: 'reason',
        items: [...toolItems, { itemType: 'step' as const, index: step, content }],
        timestamp: Date.now(),
      },
    ]
  }
  return [
    ...sections,
    { type: 'reason', items: [{ itemType: 'step', index: step, content }], timestamp: Date.now() },
  ]
}

/**
 * 登记一次工具调用为 running 并打上计时起点；params 为空对象时不写该字段。
 *
 * @param sections - 组装中的 section 列表。
 * @param callId - 工具调用稳定 ID，后续按它结算结果。
 * @param toolName - 工具名，仅用于展示。
 * @param params - 调用参数；为空或省略时不写 `params` 字段。
 * @returns 追加后的新 section 列表（不可变，输入不被修改）。
 */
export function applyToolStart(
  sections: MessageSection[],
  callId: string,
  toolName: string,
  params?: Record<string, unknown>
): MessageSection[] {
  const last = sections[sections.length - 1]
  // startedAtMs：live 耗时打点（spec: process-fold-timeline §4）；结算时清除
  const tool: ToolCard = {
    callId,
    name: toolName,
    status: 'running',
    startedAtMs: Date.now(),
    ...(params && Object.keys(params).length > 0 ? { params: JSON.stringify(params) } : {}),
  }
  if (last && last.type === 'reason') {
    // 按时间顺序插入到 items 末尾
    return [
      ...sections.slice(0, -1),
      { ...last, items: [...last.items, { itemType: 'tool' as const, tool }] },
    ]
  }
  if (last && last.type === 'tool_group') {
    return [...sections.slice(0, -1), { ...last, tools: [...last.tools, tool] }]
  }
  return [...sections, { type: 'tool_group', tools: [tool], timestamp: Date.now() }]
}

/**
 * 结算耗时：有打点则算 durationMs 并清除打点（旧数据/无打点不补）
 *
 * @param t - 目标工具卡片；缺 `startedAtMs` 打点时按零补丁处理，不做推算。
 * @returns 只含 `durationMs` 与清除打点的最小补丁。
 */
function settleDuration(t: ToolCard): Partial<ToolCard> {
  if (t.startedAtMs === null || t.startedAtMs === undefined) return {}
  return { durationMs: Math.max(0, Date.now() - t.startedAtMs), startedAtMs: undefined }
}

/**
 * 按 callId 更新工具状态（tool_group 与 reason 内嵌工具两处都可能命中）
 *
 * @param sections - 待打补丁的 section 列表。
 * @param callId - 目标工具调用的稳定 ID。
 * @param patch - 依据当前工具卡片返回增量补丁的纯函数。
 * @returns 打补丁后的新 section 列表；未命中的保持原样（不可变）。
 */
function mapTool(
  sections: MessageSection[],
  callId: string,
  patch: (t: ToolCard) => Partial<ToolCard>
): MessageSection[] {
  return sections.map((section) => mapToolInSection(section, callId, patch))
}

/**
 * 在单个 section 内按 callId 打补丁：tool_group 与 reason 内嵌工具两处都可能命中。
 *
 * @param section - 待打补丁的单个 section。
 * @param callId - 目标工具调用的稳定 ID。
 * @param patch - 依据当前工具卡片返回增量补丁的纯函数。
 * @returns 打补丁后的 section；非 tool_group/reason 或未命中时原样返回。
 */
function mapToolInSection(
  section: MessageSection,
  callId: string,
  patch: (t: ToolCard) => Partial<ToolCard>
): MessageSection {
  if (section.type === 'tool_group') {
    return {
      ...section,
      tools: section.tools.map((t) => (t.callId === callId ? { ...t, ...patch(t) } : t)),
    }
  }
  if (section.type === 'reason') {
    return {
      ...section,
      items: section.items.map((item) =>
        item.itemType === 'tool' && item.tool && item.tool.callId === callId
          ? { ...item, tool: { ...item.tool, ...patch(item.tool) } }
          : item
      ),
    }
  }
  return section
}

/**
 * 按 callId 把工具标记为成功并写入结果，同时结算耗时。
 *
 * @param sections - 组装中的 section 列表。
 * @param callId - 目标工具调用的稳定 ID。
 * @param result - 工具返回的结果文本。
 * @returns 打补丁后的新 section 列表；未命中的 callId 保持原样。
 */
export function applyToolResult(
  sections: MessageSection[],
  callId: string,
  result: string
): MessageSection[] {
  return mapTool(sections, callId, (t) => ({ status: 'success', result, ...settleDuration(t) }))
}

/**
 * 按 callId 把工具标记为失败并写入错误，同时结算耗时。
 *
 * @param sections - 组装中的 section 列表。
 * @param callId - 目标工具调用的稳定 ID。
 * @param error - 失败原因文本。
 * @returns 打补丁后的新 section 列表；未命中的 callId 保持原样。
 */
export function applyToolFail(
  sections: MessageSection[],
  callId: string,
  error: string
): MessageSection[] {
  return mapTool(sections, callId, (t) => ({ status: 'failed', error, ...settleDuration(t) }))
}

/**
 * 把仍处于 running 的单个工具收成 incomplete 终态并结算耗时；已终态的保持原样。
 *
 * @param tool - 待结算的工具卡片。
 * @returns 结算后的工具卡片；非 running 状态时原样返回。
 */
function settleRunningTool(tool: ToolCard): ToolCard {
  if (tool.status !== 'running') return tool
  return { ...tool, status: 'incomplete', ...settleDuration(tool) }
}

/**
 * 流结束前的兜底结算：没有 tool_result 的 Tool 统一派生为 incomplete。
 * 主流程、reason 内嵌 Tool、子 Agent 内层 sections 与纯渲染 process 都递归覆盖；
 * 同时把仍为 running 的委派标为 incomplete，避免终态页面永久显示“正在执行”。
 *
 * @param sections - 需要兜底结算的 section 列表。
 * @returns 结算后的新 section 列表；已处于终态的工具保持原样。
 */
export function settleIncompleteTools(sections: MessageSection[]): MessageSection[] {
  return sections.map(settleIncompleteSection)
}

/**
 * 兜底结算单个 section：把其中仍 running 的工具与委派标为 incomplete。
 *
 * @param section - 待结算的单个 section，递归覆盖工具、理由、子 Agent 与 process 步骤。
 * @returns 结算后的 section；不属于上述类型时原样返回。
 */
function settleIncompleteSection(section: MessageSection): MessageSection {
  if (section.type === 'tool_group') {
    return { ...section, tools: section.tools.map(settleRunningTool) }
  }
  if (section.type === 'reason') {
    return {
      ...section,
      items: section.items.map((item) =>
        item.itemType === 'tool' && item.tool
          ? { ...item, tool: settleRunningTool(item.tool) }
          : item
      ),
    }
  }
  if (section.type === 'sub_agent') {
    return {
      ...section,
      items: settleSubAgent(section.items),
    }
  }
  if (section.type === 'process') {
    return {
      ...section,
      steps: section.steps.map(settleIncompleteStep),
    }
  }
  return section
}

/**
 * 兜底结算单个 Process 步骤：工具本身与它挂载的委派都要收成终态。
 *
 * @param step - 待结算的 process 步骤，tool 与 sub_agent 两类分别收口。
 * @returns 结算后的步骤；非 tool/sub_agent 类型时原样返回。
 */
function settleIncompleteStep(step: ProcessStepItem): ProcessStepItem {
  if (step.kind === 'tool' && step.tool) {
    return {
      ...step,
      tool: settleRunningTool(step.tool),
      subAgent: step.subAgent ? settleSubAgent(step.subAgent) : undefined,
    }
  }
  if (step.kind === 'sub_agent' && step.subAgent) {
    return {
      ...step,
      subAgent: settleSubAgent(step.subAgent),
    }
  }
  return step
}

/**
 * 兜底结算子 Agent 数据：running 状态收成 incomplete，并递归结算其内层 sections。
 *
 * @param data - 子 Agent section 数据；`sections` 缺省时按空数组处理。
 * @returns 状态与内层 section 均已收口的新子 Agent 数据（不可变）。
 */
function settleSubAgent(data: SubAgentSectionData): SubAgentSectionData {
  return {
    ...data,
    status: data.status === 'running' ? ('incomplete' as const) : data.status,
    sections: settleIncompleteTools(data.sections ?? []),
  }
}
