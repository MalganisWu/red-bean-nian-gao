import type { SubExecutionRecord } from '../../subagent/model/sub-execution.js'
import type { TrajectoryRecord } from '../model/trajectory.js'
import {
  firstLine,
  isRecord,
  readDuration,
  readMs,
  readReasonText,
  readString,
  type SectionLike,
  type SubAgentSectionLike,
  type ToolItemLike,
} from './trajectory-section-reader.js'

/**
 * 段 → 记录的映射上下文：序号由投影器统一分配；子执行索引与子 Agent token 累计
 * 由投影器持有，经本接口传入。
 */
export interface RecordMapperContext {
  readonly subByCallId: ReadonlyMap<string, SubExecutionRecord>
  /** 分配下一条记录（返回完整 id 与序号）。 */
  nextRecord(kind: TrajectoryRecord['kind'], at: number, summary: string): TrajectoryRecord
  /** 子 Agent token 累计（会话合计用）。 */
  addSubAgentTokens(tokens: number): void
}

/** reason 段 → 调用记录（思考）。G0 的 reason 段归属「上一次调用」由投影器按位置表达。 */
export function reasonRecord(section: SectionLike, ctx: RecordMapperContext): TrajectoryRecord {
  const thinking = readReasonText(section)
  const base = ctx.nextRecord('call', readMs(section['timestamp']), firstLine(thinking))
  return {
    ...base,
    thinking,
    durationMs: readDuration(section['duration']),
    tokens: null,
    attempts: [],
  }
}

/** tool_group 段 → 逐工具记录。 */
export function toolRecords(section: SectionLike, ctx: RecordMapperContext): TrajectoryRecord[] {
  const tools = section['tools']
  if (!Array.isArray(tools)) return []
  const at = readMs(section['timestamp'])
  const out: TrajectoryRecord[] = []
  for (const item of tools) {
    if (!isRecord(item)) continue
    const record = toolRecord(item, at, ctx)
    if (record !== null) out.push(record)
  }
  return out
}

/** 单个工具项 → 工具记录；缺名称的脏数据跳过。 */
export function toolRecord(
  item: ToolItemLike,
  groupAt: number,
  ctx: RecordMapperContext
): TrajectoryRecord | null {
  const name = readString(item['name'])
  if (name === null) return null
  const status = readString(item['status'])
  const failed = status === 'failed'
  const errorText = readString(item['error'])
  const resultText = readString(item['result'])
  const summary = failed
    ? `${name} 失败${errorText !== null ? `：${firstLine(errorText)}` : ''}`
    : firstLine(resultText ?? name)
  const base = ctx.nextRecord('tool', groupAt, summary)
  return {
    ...base,
    name,
    status: failed ? 'error' : 'success',
    durationMs: readDuration(item['duration']),
    params: readString(item['params']) ?? undefined,
    result: failed ? (errorText ?? undefined) : (resultText ?? undefined),
  }
}

/**
 * card 段 → 审批工具行（LLM 调用 interrupting 工具后的挂起交互）。
 * 状态按触发者：`pending` 是 LLM 发起挂起 → `interrupt`；`refused` 沿用既有语义记 `error`。
 */
export function cardRecord(
  section: SectionLike,
  ctx: RecordMapperContext
): TrajectoryRecord | null {
  const card = section['card']
  if (!isRecord(card)) return null
  const status = readString(card['status'])
  const base = ctx.nextRecord('tool', readMs(section['timestamp']), '人工确认')
  return {
    ...base,
    name: 'approval',
    status: status === 'pending' ? 'interrupt' : status === 'refused' ? 'error' : 'success',
    durationMs: readDuration(section['duration']),
  }
}

/** sub_agent 段 → 子 Agent 记录，并按 parent_call_id 并入子执行记录（token/耗时/模型/结果）。 */
export function subAgentRecord(
  section: SectionLike,
  ctx: RecordMapperContext
): TrajectoryRecord | null {
  const items = section['items']
  if (!isRecord(items)) return null
  const data: SubAgentSectionLike = items
  const parentCallId = readString(data['parent_call_id'])
  const sub = parentCallId !== null ? ctx.subByCallId.get(parentCallId) : undefined
  if (sub !== undefined) ctx.addSubAgentTokens(sub.tokensUsed)
  const agentName = readString(data['agent_name']) ?? sub?.agentName ?? '子 Agent'
  const summaryText = readString(data['result_summary']) ?? sub?.resultSummary ?? agentName
  const subStatus = readString(data['status']) ?? sub?.status
  const base = ctx.nextRecord('subagent', readMs(section['timestamp']), firstLine(summaryText))
  return {
    ...base,
    name: agentName,
    model: sub?.modelName,
    totalTokens: sub?.tokensUsed,
    durationMs: sub?.elapsedMilliseconds,
    status: subStatus === 'failed' ? 'error' : 'success',
    result: sub?.resultSummary ?? undefined,
  }
}
