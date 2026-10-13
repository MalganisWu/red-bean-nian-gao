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
  /** 事件类型判别符；固定值，用于把内部交接事件从普通 Runtime 事件里筛出来。 */
  readonly type: 'sub_agent_display_ready'
  /** 子执行展示载荷；已归一为可序列化 JSON，绝不越过 SSE 边界。 */
  readonly data: AgentJsonValue
}

/** `sub_agent` 展示 section 使用的持久化载荷。 */
export interface SubAgentSectionData {
  /** 子 Agent 定义标识。 */
  readonly agentId: string
  /** 子 Agent 展示名；父会话据此渲染分区标题。 */
  readonly agentName: string
  /** 子执行标识；用于把展示分区关联回持久化记录。 */
  readonly executionId: string
  /** 发起委派的父工具调用 id；空串或缺失表示不写该字段。 */
  readonly parentCallId?: string | undefined
  /** 子执行的展示 section 集合；落库前会被深拷贝。 */
  readonly sections: AgentJsonValue
  /** 子执行状态字符串；这里的裸字符串由领域层在落库前映射。 */
  readonly status: string
  /** 结果摘要；空串或缺失表示不写该字段。 */
  readonly resultSummary?: string | undefined
}

/** 给子 Agent 事件套上父调用标识；`event` 既可能是 Runtime 事件，也可能是产品内部的展示交接事件。 */
export interface SubAgentEnvelope {
  /** 发起委派的父工具调用 id；是子段归位与结果回填的关联键。 */
  readonly parentCallId: string
  /** 被套信封的事件；可能是 Runtime 事件，也可能是内部展示交接事件。 */
  readonly event: AgentRuntimeEvent | SubAgentDisplayReadyEvent
}

/** 产品 pipeline 中流动的事件全集：Runtime 事件，或带父调用标识的信封。 */
export type ProductPipelineEvent = AgentRuntimeEvent | SubAgentEnvelope

/** pipeline 节点共享的上下文；`eventSink` 可变，因为节点会把它包一层再往下传（见 `SectionBuildNode.execute`）。 */
export interface ProductPipelineContext {
  /** 节点间共享的元数据；注册表等跨节点状态放在这里，按 key 读写。 */
  readonly metadata: Map<string, unknown>
  /**
   * 事件出口；节点会接管它再往下传，undefined 表示尚无下游 sink。
   * @param event - pipeline 中流动的事件；节点接管出口后先消费内部事件，其余再转发给它。
   */
  eventSink: ((event: ProductPipelineEvent) => void) | undefined
}

/** 归集本节点看到的事件，产出展示 section。 */
export interface SectionEventCollector {
  /**
   * 归集一条 pipeline 事件，内部按其类型累积成展示 section。
   *
   * @param event - pipeline 中流动的事件。
   */
  collect(event: ProductPipelineEvent): void
}

/** 每次执行新建一个收集器，避免上一次运行的 section 泄漏到下一次。 */
export type SectionEventCollectorFactory = () => SectionEventCollector

/** 按发起委派的父调用保存相互独立的 JSON 快照。 */
export class SubExecDisplayRegistry implements SubAgentDisplayRegistryPort {
  /** 父调用 id → 展示载荷 的快照表；写入时克隆，读写两侧都不共享可变引用。 */
  readonly #data = new Map<string, AgentJsonValue>()

  /**
   * 登记一次子执行的展示载荷；按父调用 ID 覆盖同一委派的旧快照。
   *
   * @param parentCallId - 发起委派的父工具调用 ID，作为归属键
   * @param data - 子执行的展示载荷；写入前先克隆，避免共享可变引用
   */
  public set(parentCallId: string, data: AgentJsonValue): void {
    this.#data.set(parentCallId, cloneJson(data))
  }

  /**
   * 快照当前全部展示载荷；逐项克隆，调用方改动不影响注册表内部状态。
   *
   * @returns 父调用 ID → 展示载荷 的只读副本
   */
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
  /** 节点名；pipeline 组装按它识别本节点。 */
  public readonly name = 'SectionBuildNode'
  /** 收集器工厂；每次 execute 新建一个，避免上一次运行的事件泄漏到本次。 */
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
   *
   * @param context - pipeline 上下文；其 metadata 供内部事件捕获查注册表，eventSink 会被本节点接管
   * @param signal - 中止信号；进入即检查，已中止则快速失败
   */
  public execute(context: ProductPipelineContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const collector = this.#createCollector()
    const originalSink = context.eventSink
    /** 接管事件出口：内部交接事件被消费掉后不再转发，其余先喂收集器、再交给原出口。 */
    function publishEvent(event: ProductPipelineEvent): void {
      if (captureSubAgentDisplayEvent(event, context.metadata)) return
      collector.collect(event)
      originalSink?.(event)
    }
    context.eventSink = publishEvent
    return Promise.resolve()
  }
}

/**
 * 造一个展示交接事件；载荷先过 `toAgentJsonValue` 归一，保证它可被序列化与克隆。
 *
 * @param data - 任意展示载荷；经归一化后写入事件
 * @returns 内部展示交接事件（不得越过 SSE 边界）
 */
export function subAgentDisplayReadyEvent(data: unknown): SubAgentDisplayReadyEvent {
  return { type: 'sub_agent_display_ready', data: toAgentJsonValue(data) }
}

/**
 * 把 section 载荷转成落库用的 snake_case JSON；空串与 `undefined` 同等对待，都不写入该字段。
 *
 * @param data - 子 Agent section 载荷
 * @returns snake_case 的 JSON 对象；可选字段为空串 / undefined 时省略
 */
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
 *
 * @param event - pipeline 事件；只有「带父调用标识的展示交接事件」会被消费
 * @param metadata - pipeline 元数据；从中取注册表，缺失时仍消费事件但不落库
 * @returns 是否为本节点消费的内部交接事件（true 表示不再转发）
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
 *
 * @param messages - 父运行的展示消息序列；data 为空时原样返回
 * @param data - 父调用 ID → 子执行展示载荷 的映射
 * @returns 插入子执行 section 后的消息；无匹配时不改变原消息
 */
export function embedSubAgentSections(
  messages: readonly DisplayMessage[],
  data: ReadonlyMap<string, AgentJsonValue>
): readonly DisplayMessage[] {
  if (data.size === 0) return messages
  return messages.map((message): DisplayMessage => embedMessage(message, data))
}

/**
 * 处理单条展示消息：在匹配的子 Agent 委派工具组之后插入其展示 section。
 * 非 assistant、无 sections 或未插入任何子段时返回消息的浅拷贝，绝不改写原消息；
 * 匹配键是父工具调用的 callId，插入位置紧贴那一组工具，阅读顺序才是「父委派 → 子返回」。
 *
 * @param message - 父运行的一条展示消息。
 * @param data - 父调用 ID → 子执行展示载荷 的映射。
 * @returns 插入子执行 section 后的消息；无匹配时是原消息的浅拷贝。
 */
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

/**
 * 校验并克隆展示 sections：存在任一个非对象元素即视为脏数据，返回 undefined 让上层保留原样。
 *
 * @param value - 待校验的 section 数组。
 * @returns 逐项深拷贝后的 section 数组；含非法元素时为 undefined。
 */
function parseSections(value: AgentJsonValue[]): AgentJsonValue[] | undefined {
  return value.every(isJsonObject) ? value.map(cloneJson) : undefined
}

/**
 * 从工具项里读取父工具调用的 callId；非对象或缺字段时返回 undefined。
 * 该 id 既用于匹配子执行载荷，也是父运行与子执行之间的关联键。
 *
 * @param value - 展示 section 里的单个工具项。
 * @returns 工具调用的 callId；读不到时为 undefined。
 */
function toolCallId(value: AgentJsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined
  const callId = value['callId']
  return typeof callId === 'string' ? callId : undefined
}

/**
 * 给子执行展示载荷补上父调用标识，供前端把子段归到正确的父委派下。
 * 载荷不是对象时退化为深拷贝，避免在非法数据上抛错。
 *
 * @param data - 子执行的展示载荷。
 * @param parentCallId - 发起委派的父工具调用 ID。
 * @returns 带 `parent_call_id` 的载荷副本。
 */
function withParentCallId(data: AgentJsonValue, parentCallId: string): AgentJsonValue {
  if (!isJsonObject(data)) return cloneJson(data)
  return { ...cloneJsonObject(data), parent_call_id: parentCallId }
}

/**
 * 判定事件是否为「带父调用标识的信封」，用于把子 Agent 事件与普通 Runtime 事件分开。
 *
 * @param event - pipeline 中流动的事件。
 * @returns 是信封时为 true，并把类型收窄为 `SubAgentEnvelope`。
 */
function isSubAgentEnvelope(event: ProductPipelineEvent): event is SubAgentEnvelope {
  return 'parentCallId' in event && 'event' in event
}

/**
 * 判定值是否为普通 JSON 对象，用于把宽松展示数据收窄成 `AgentJsonObject`。
 *
 * @param value - 待判定的 JSON 值。
 * @returns 是对象时为 true，并把类型收窄为 `AgentJsonObject`。
 */
function isJsonObject(value: AgentJsonValue): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深拷贝一个 JSON 值，切断与调用方之间的共享可变引用，注册表内部状态不被外部改动影响。
 *
 * @param value - 待拷贝的 JSON 值。
 * @returns 独立的深拷贝。
 */
function cloneJson(value: AgentJsonValue): AgentJsonValue {
  return structuredClone(value)
}

/**
 * 深拷贝一个 JSON 对象，并断言拷贝后仍然是对象。
 * `structuredClone` 对纯对象不会改变形状，这里显式校验是为了在类型层面留住 `AgentJsonObject`：
 * 一旦形状意外改变就立刻抛出，而不是把错误类型悄悄带下去。
 *
 * @param value - 待拷贝的 JSON 对象。
 * @returns 独立的深拷贝。
 */
function cloneJsonObject(value: AgentJsonObject): AgentJsonObject {
  const clone = cloneJson(value)
  if (!isJsonObject(clone)) throw new Error('JSON object clone unexpectedly changed shape')
  return clone
}
