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

/** 给子 Agent 事件套上父调用标识；`event` 既可能是 Runtime 事件，也可能是产品内部的展示交接事件。 */
export interface SubAgentEnvelope {
  readonly parentCallId: string
  readonly event: AgentRuntimeEvent | SubAgentDisplayReadyEvent
}

/** 产品 pipeline 中流动的事件全集：Runtime 事件，或带父调用标识的信封。 */
export type ProductPipelineEvent = AgentRuntimeEvent | SubAgentEnvelope

/** pipeline 节点共享的上下文；`eventSink` 可变，因为节点会把它包一层再往下传（见 `SectionBuildNode.execute`）。 */
export interface ProductPipelineContext {
  readonly metadata: Map<string, unknown>
  eventSink: ((event: ProductPipelineEvent) => void) | undefined
}

/** 归集本节点看到的事件，产出展示 section。 */
export interface SectionEventCollector {
  collect(event: ProductPipelineEvent): void
}

/** 每次执行新建一个收集器，避免上一次运行的 section 泄漏到下一次。 */
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

  /**
   * 接管事件出口：内部交接事件被捕获后**不再转发**（`return`），其余事件
   * 先喂给本节点的收集器、再交给原来的出口。
   *
   * 拦截必须发生在 transport sink 之前——`sub_agent_display_ready` 是产品内部的
   * 展示交接，一旦漏到 SSE 上，前端会收到一个它不认识的、也不该看到的内部事件。
   * 收集器在 `execute` 里新建，因此每个节点只拥有本次执行产生的事件。
   */
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

/** 造一个展示交接事件；载荷先过 `toAgentJsonValue` 归一，保证它可被序列化与克隆。 */
export function subAgentDisplayReadyEvent(data: unknown): SubAgentDisplayReadyEvent {
  return { type: 'sub_agent_display_ready', data: toAgentJsonValue(data) }
}

/** 把 section 载荷转成落库用的 snake_case JSON；空串与 `undefined` 同等对待，都不写入该字段。 */
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
 *
 * 注册表缺失时**同样返回 true**（消费掉但不存）：这类事件无论如何都不该流出去，
 * 「存不下」和「不该转发」是两件事，不能因为前者失败就放行后者。
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
 *
 * 匹配键是**父工具调用的 callId**：子执行是由父运行里某次委派工具调用发起的，
 * 把结果插在那一组工具之后，用户的阅读顺序才是「父调用了子 → 子返回了什么」。
 * 找不到匹配（`inserted` 为假）时返回原消息的浅拷贝，不做任何改动。
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
