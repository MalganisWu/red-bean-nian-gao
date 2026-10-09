import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import { toAgentJsonValue } from '../../serialization/json-value-normalizer.js'
import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { SubAgentDisplayRegistryPort } from '../../loader/port/agent-loader.port.js'

/** 父运行接收子 Agent 展示交接数据时使用的 Runtime metadata key。 */
export const SUB_EXEC_DISPLAY_METADATA_KEY = 'sub_exec_display'

/**
 * 只在产品内部传给父 presentation adapter 的事件，绝不能越过 SSE 边界。
 * Runtime 事件必须保持 SDK 中性。
 */
export interface SubAgentDisplayReadyEvent {
  readonly type: 'sub_agent_display_ready'
  readonly data: AgentJsonValue
}

/** `sub_agent` 展示 section 使用的持久化载荷。 */
export interface SubAgentSectionData {
  readonly agentId: string
  readonly agentName: string
  readonly executionId: string
  readonly parentCallId?: string | undefined
  readonly sections: AgentJsonValue
  readonly status: string
  readonly resultSummary?: string | undefined
}

export interface SubAgentEnvelope {
  readonly parentCallId: string
  readonly event: AgentRuntimeEvent | SubAgentDisplayReadyEvent
}

export type ProductPipelineEvent = AgentRuntimeEvent | SubAgentEnvelope

export interface ProductPipelineContext {
  readonly metadata: Map<string, unknown>
  eventSink: ((event: ProductPipelineEvent) => void) | undefined
}

export interface SectionEventCollector {
  collect(event: ProductPipelineEvent): void
}

export type SectionEventCollectorFactory = () => SectionEventCollector

/** 按发起委派的父调用保存相互独立的 JSON 快照。 */
export class SubExecDisplayRegistry implements SubAgentDisplayRegistryPort {
  readonly #data = new Map<string, AgentJsonValue>()

  public set(parentCallId: string, data: AgentJsonValue): void {
    this.#data.set(parentCallId, cloneJson(data))
  }

  public data(): ReadonlyMap<string, AgentJsonValue> {
    const snapshot = new Map<string, AgentJsonValue>()
    for (const [parentCallId, data] of this.#data) {
      snapshot.set(parentCallId, cloneJson(data))
    }
    return snapshot
  }
}

/** 把一次子 Agent 事件流归并为展示 section；节点只拥有本次 execute 创建的 Collector。 */
export class SectionBuildNode {
  public readonly name = 'SectionBuildNode'
  readonly #createCollector: SectionEventCollectorFactory

  public constructor(createCollector: SectionEventCollectorFactory) {
    this.#createCollector = createCollector
  }

  public execute(context: ProductPipelineContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const collector = this.#createCollector()
    const originalSink = context.eventSink
    context.eventSink = (event: ProductPipelineEvent): void => {
      if (captureSubAgentDisplayEvent(event, context.metadata)) return
      collector.collect(event)
      originalSink?.(event)
    }
    return Promise.resolve()
  }
}

export function subAgentDisplayReadyEvent(data: unknown): SubAgentDisplayReadyEvent {
  return { type: 'sub_agent_display_ready', data: toAgentJsonValue(data) }
}

export function serializeSubAgentSectionData(data: SubAgentSectionData): AgentJsonObject {
  const payload: Record<string, AgentJsonValue> = {
    agent_id: data.agentId,
    agent_name: data.agentName,
    execution_id: data.executionId,
    sections: cloneJson(data.sections),
    status: data.status,
  }
  if (data.parentCallId !== undefined && data.parentCallId !== '') {
    payload['parent_call_id'] = data.parentCallId
  }
  if (data.resultSummary !== undefined && data.resultSummary !== '') {
    payload['result_summary'] = data.resultSummary
  }
  return payload
}

/**
 * 只捕获面向父运行的展示交接数据。返回的布尔值供 stream decorator 在 transport sink 前过滤内部事件。
 */
export function captureSubAgentDisplayEvent(
  event: ProductPipelineEvent,
  metadata: ReadonlyMap<string, unknown>
): boolean {
  if (!isSubAgentEnvelope(event) || event.event.type !== 'sub_agent_display_ready') return false
  const registry = metadata.get(SUB_EXEC_DISPLAY_METADATA_KEY)
  if (!(registry instanceof SubExecDisplayRegistry)) return true
  registry.set(event.parentCallId, event.event.data)
  return true
}

/**
 * 将子执行展示数据紧接着匹配的父 tool group 插入。
 * 非法历史会被保留，避免一条损坏记录导致整个视图被擦除。
 */
export function embedSubAgentSections(
  messages: readonly DisplayMessage[],
  data: ReadonlyMap<string, AgentJsonValue>
): readonly DisplayMessage[] {
  if (data.size === 0) return messages
  return messages.map((message): DisplayMessage => embedMessage(message, data))
}

function embedMessage(
  message: DisplayMessage,
  data: ReadonlyMap<string, AgentJsonValue>
): DisplayMessage {
  if (message.role !== 'assistant' || !Array.isArray(message.sections)) return { ...message }
  const sections = parseSections(message.sections)
  if (sections === undefined) return { ...message }

  const rebuilt: AgentJsonValue[] = []
  let inserted = false
  for (const section of sections) {
    rebuilt.push(section)
    if (!isJsonObject(section) || section['type'] !== 'tool_group') continue
    const tools = section['tools']
    if (!Array.isArray(tools)) continue
    for (const tool of tools) {
      const callId = toolCallId(tool)
      if (callId === undefined) continue
      const childData = data.get(callId)
      if (childData === undefined) continue
      rebuilt.push({ type: 'sub_agent', items: withParentCallId(childData, callId), timestamp: 0 })
      inserted = true
    }
  }
  if (!inserted) return { ...message }
  return { ...message, sections: rebuilt }
}

function parseSections(value: AgentJsonValue[]): AgentJsonValue[] | undefined {
  return value.every(isJsonObject) ? value.map(cloneJson) : undefined
}

function toolCallId(value: AgentJsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined
  const callId = value['callId']
  return typeof callId === 'string' ? callId : undefined
}

function withParentCallId(data: AgentJsonValue, parentCallId: string): AgentJsonValue {
  if (!isJsonObject(data)) return cloneJson(data)
  return { ...cloneJsonObject(data), parent_call_id: parentCallId }
}

function isSubAgentEnvelope(event: ProductPipelineEvent): event is SubAgentEnvelope {
  return 'parentCallId' in event && 'event' in event
}

function isJsonObject(value: AgentJsonValue): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson(value: AgentJsonValue): AgentJsonValue {
  return structuredClone(value)
}

function cloneJsonObject(value: AgentJsonObject): AgentJsonObject {
  const clone = cloneJson(value)
  if (!isJsonObject(clone)) throw new Error('JSON object clone unexpectedly changed shape')
  return clone
}
