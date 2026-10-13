import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import type { ChildSectionCollector } from '../../subagent/run/port/child-execution-lifecycle.port.js'
import type { SectionEventCollector } from '../../subagent/service/subagent-display.js'
import type { PresentationClock } from './display-message-collector.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/** 工具在 section 时间线里的可变中间态；status 随 tool_result 改写，最终由 serializeToolItem 固化。 */
interface MutableToolItem {
  /** 本次工具调用的标识；tool_result 按它回填状态。 */
  readonly callId: string
  /** 工具名。 */
  readonly name: string
  /** 工具入参的 JSON 字符串；缺省表示无参数。 */
  readonly params?: string | undefined
  /** 工具执行状态；随 tool_result 改写，最终由 serializeToolItem 固化。 */
  status: 'running' | 'success' | 'failed'
  /** 工具成功时的结果正文。 */
  result?: string | undefined
  /** 工具失败时的错误信息；有值即表示失败。 */
  error?: string | undefined
  /** 工具执行耗时（毫秒）；由 tool_result 结算。 */
  duration?: number | undefined
}

/** 推理缓冲区里的单条 step 项；同一段推理的增量都累加到 content，flush 时整段固化。 */
interface ReasonItem {
  /** 项类型判别字段，恒为 `step`。 */
  readonly itemType: 'step'
  /** 该段推理累积的文本；增量事件不断追加到这里。 */
  content: string
}

/**
 * 使用发送到 SSE 的同一批中性事件重建持久化 section 时间线。
 *
 * 「同一批」是关键：持久化的时间线与用户当时看到的帧来自同一串事件，
 * 因此刷新页面后重放出来的过程与实时看到的一致，不会出现「存下来的和看过的不一样」。
 *
 * 内部按三类内容分别攒缓冲（推理 / 正文 / 工具组），收到另一类事件时先把当前类 flush 出去——
 * 时间线的顺序就是 flush 的顺序，这样「边想边调工具边说」的真实交错才不会被抹平成三段。
 */
export class SectionCollector implements ChildSectionCollector, SectionEventCollector {
  /** 时间戳来源；可注入，测试据此产出确定的时间。 */
  readonly #now: PresentationClock
  /** 已 flush 出的 section 时间线；顺序即 flush 顺序。 */
  readonly #sections: Record<string, AgentJsonValue>[] = []
  /** 推理缓冲；收到不同类事件或 build 时整段 flush。 */
  readonly #reasonItems: ReasonItem[] = []
  /** 工具组缓冲；收到不同类事件或 build 时整组 flush。 */
  readonly #toolItems: MutableToolItem[] = []
  /** 各工具调用的开始时间，按 callId 索引；用于结算 duration。 */
  readonly #toolStartedAt = new Map<string, number>()
  /** 当前推理段起点（epoch 毫秒）；0 表示无进行中的推理段。 */
  #reasonStartedAt = 0
  /** 当前正文段起点（epoch 毫秒）；0 表示无进行中的正文段。 */
  #contentStartedAt = 0
  /** 当前工具组起点（epoch 毫秒）；0 表示无进行中的工具组。 */
  #toolGroupStartedAt = 0

  public constructor(now: PresentationClock = Date.now) {
    this.#now = now
  }

  /**
   * 消费一个中性运行时事件并更新 section 时间线。
   * 收到与当前缓冲不同类的事件时先 flush 当前类，让「边想边调工具边说」的交错顺序原样保留。
   * @param event 发往 SSE 的同一批中性事件之一；status / compaction 不产生 section，直接返回
   */
  public collect(event: AgentRuntimeEvent): void {
    switch (event.type) {
      case 'reason': {
        this.#flushContent()
        this.#flushTools()
        if (this.#reasonItems.length === 0) this.#reasonStartedAt = event.timestamp
        const previous = this.#reasonItems.at(-1)
        if (previous !== undefined) previous.content += event.content
        else this.#reasonItems.push({ itemType: 'step', content: event.content })
        return
      }
      case 'token':
        this.#flushReason()
        this.#flushTools()
        this.#appendContent(event.content)
        return
      case 'tool_start':
        this.#flushReason()
        this.#flushContent()
        // 已有工具在跑 → 并入同一组（模型并发下发多个调用）。
        // 全都跑完又来新的 → 先收束上一组，让界面上呈现为两批而不是一个越来越长的列表。
        if (this.#toolItems.some((tool): boolean => tool.status === 'running')) {
          this.#appendTool(event.toolName, event.callId, event.params)
          return
        }
        this.#flushTools()
        this.#appendTool(event.toolName, event.callId, event.params)
        return
      case 'tool_result': {
        const tool = this.#toolItems.find((item): boolean => item.callId === event.callId)
        if (tool === undefined) return
        const startedAt = this.#toolStartedAt.get(event.callId)
        if (startedAt !== undefined) tool.duration = Math.max(0, this.#now() - startedAt)
        this.#toolStartedAt.delete(event.callId)
        if (event.error !== undefined && event.error !== '') {
          tool.status = 'failed'
          tool.error = event.error
        } else {
          tool.status = 'success'
          tool.result = event.content
        }
        return
      }
      case 'compaction':
      case 'status':
        return
    }
  }

  /**
   * 取快照前必须把三个缓冲全部 flush，否则最后一段内容会留在缓冲里丢失。
   * @returns 已 flush 完成的 section 时间线深拷贝，可供持久化或 SSE 投影
   */
  public build(): AgentJsonValue {
    this.#flushReason()
    this.#flushContent()
    this.#flushTools()
    return structuredClone(this.#sections)
  }

  /**
   * 追加正文增量：末尾已是 content 分节就续写，否则新起一段并记下起点。
   * @param content 本 token 的正文增量；累加到末尾 content 分节的 content 字段
   */
  #appendContent(content: string): void {
    const last = this.#sections.at(-1)
    if (last !== undefined && last['type'] === 'content') {
      const current = last['content']
      last['content'] = `${typeof current === 'string' ? current : ''}${content}`
      return
    }
    this.#contentStartedAt = this.#now()
    this.#sections.push({ type: 'content', content, timestamp: this.#contentStartedAt })
  }

  /**
   * 把一个工具调用加入当前工具组缓冲：首次入组时记下组起点，并登记该调用的开始时间。
   * @param name 工具名
   * @param callId 本次调用的标识；同时作为 duration 结算的键
   * @param params 工具入参；为 null 时不写 params 键
   */
  #appendTool(name: string, callId: string, params: AgentJsonObject | null): void {
    const now = this.#now()
    if (this.#toolItems.length === 0) this.#toolGroupStartedAt = now
    this.#toolStartedAt.set(callId, now)
    this.#toolItems.push({
      callId,
      name,
      status: 'running',
      ...(params === null ? {} : { params: JSON.stringify(params) }),
    })
  }

  /** 把推理缓冲固化为一个 reason 分节并清空；缓冲为空时不产生任何分节。 */
  #flushReason(): void {
    if (this.#reasonItems.length === 0) return
    const now = this.#now()
    this.#sections.push({
      type: 'reason',
      items: this.#reasonItems.map((item): AgentJsonValue => ({ ...item })),
      timestamp: this.#reasonStartedAt,
      duration: Math.max(0, now - this.#reasonStartedAt),
    })
    this.#reasonItems.length = 0
    this.#reasonStartedAt = 0
  }

  /** 给进行中的正文段补上 duration 并清空起点；无进行中的正文段时不做任何事。 */
  #flushContent(): void {
    if (this.#contentStartedAt === 0) return
    const last = this.#sections.at(-1)
    if (last !== undefined && last['type'] === 'content') {
      last['duration'] = Math.max(0, this.#now() - this.#contentStartedAt)
    }
    this.#contentStartedAt = 0
  }

  /** 把工具组缓冲固化为一个 tool_group 分节并清空；缓冲为空时不产生任何分节。 */
  #flushTools(): void {
    if (this.#toolItems.length === 0) return
    this.#sections.push({
      type: 'tool_group',
      tools: this.#toolItems.map(serializeToolItem),
      timestamp: this.#toolGroupStartedAt,
      duration: Math.max(0, this.#now() - this.#toolGroupStartedAt),
    })
    this.#toolItems.length = 0
    this.#toolStartedAt.clear()
    this.#toolGroupStartedAt = 0
  }
}

/**
 * 把工具中间态固化为 section 里的 JSON 项：可选字段统一走 optionalField 省略，
 * 缺省即不写键，保证落库结构与当时发往 SSE 的帧形状一致。
 * @param tool 工具在时间线里的中间态
 * @returns 可写入 section 的 JSON 工具项
 */
function serializeToolItem(tool: MutableToolItem): AgentJsonValue {
  return {
    callId: tool.callId,
    name: tool.name,
    status: tool.status,
    ...optionalField('params', tool.params),
    ...optionalField('result', tool.result),
    ...optionalField('error', tool.error),
    ...optionalField('duration', tool.duration),
  }
}
