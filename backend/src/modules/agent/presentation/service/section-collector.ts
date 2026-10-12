import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import type { ChildSectionCollector } from '../../subagent/run/port/child-execution-lifecycle.port.js'
import type { SectionEventCollector } from '../../subagent/service/subagent-display.js'
import type { PresentationClock } from './display-message-collector.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

interface MutableToolItem {
  readonly callId: string
  readonly name: string
  readonly params?: string | undefined
  status: 'running' | 'success' | 'failed'
  result?: string | undefined
  error?: string | undefined
  duration?: number | undefined
}

interface ReasonItem {
  readonly itemType: 'step'
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
  readonly #now: PresentationClock
  readonly #sections: Record<string, AgentJsonValue>[] = []
  readonly #reasonItems: ReasonItem[] = []
  readonly #toolItems: MutableToolItem[] = []
  readonly #toolStartedAt = new Map<string, number>()
  #reasonStartedAt = 0
  #contentStartedAt = 0
  #toolGroupStartedAt = 0

  public constructor(now: PresentationClock = Date.now) {
    this.#now = now
  }

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

  /** 取快照前必须把三个缓冲全部 flush，否则最后一段内容会留在缓冲里丢失。 */
  public build(): AgentJsonValue {
    this.#flushReason()
    this.#flushContent()
    this.#flushTools()
    return structuredClone(this.#sections)
  }

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

  #flushContent(): void {
    if (this.#contentStartedAt === 0) return
    const last = this.#sections.at(-1)
    if (last !== undefined && last['type'] === 'content') {
      last['duration'] = Math.max(0, this.#now() - this.#contentStartedAt)
    }
    this.#contentStartedAt = 0
  }

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
