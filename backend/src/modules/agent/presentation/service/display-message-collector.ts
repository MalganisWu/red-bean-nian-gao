import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentJsonValue } from '../../model/json-value.js'
import type { DisplayMessage } from '../model/display-message.js'

export interface PresentationClock {
  (): number
}

export interface DisplayMessageCollectorOptions {
  readonly now?: PresentationClock | undefined
  readonly buildSections?: (() => AgentJsonValue) | undefined
}

export interface PresentationContext {
  readonly sessionId: string
  readonly metadata: Map<string, unknown>
}

/**
 * 中性 Runtime 消息的产品展示投影。Tool 信封只保留在 LLM context 中；
 * UI 仅接收用户输入和已完成的 assistant 内容。
 *
 * 「已完成的 assistant」有两条硬条件：正文非空，且**不带 toolCalls**。
 * 工具调用轮次的 assistant 消息正文为空，是给模型看的协议结构，
 * 展示层混进去会出现一条空白的助手消息。
 *
 * `messages` 取值时深拷贝：调用方拿到的是快照，改它不会影响收集器内部状态。
 */
export class DisplayMessageCollector {
  readonly #now: PresentationClock
  readonly #buildSections: (() => AgentJsonValue) | undefined
  readonly #messages: DisplayMessage[] = []
  #runStartedAt = 0
  #runSessionId = ''

  public constructor(options: DisplayMessageCollectorOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#buildSections = options.buildSections
  }

  public get messages(): readonly DisplayMessage[] {
    return structuredClone(this.#messages)
  }

  public onUserMessage(
    context: PresentationContext,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.collectMessage(context.sessionId, message, signal)
  }

  /** 供高层 Runtime Adapter 使用，避免业务层为了展示投影构造 RuntimeContext。 */
  public collectMessage(
    sessionId: string,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    this.#markRunStart(sessionId)
    if (message.role === 'user' && message.content !== null && message.content !== '') {
      this.#messages.push({ role: 'user', content: message.content, timestamp: this.#now() })
    }
    if (
      message.role === 'assistant' &&
      message.content !== null &&
      message.content !== '' &&
      (message.toolCalls?.length ?? 0) === 0
    ) {
      const timestamp = this.#now()
      const builtSections = this.#buildSections?.()
      this.#messages.push({
        role: 'assistant',
        content: message.content,
        meta: { runStartedAt: this.#runStartedAt },
        sections:
          Array.isArray(builtSections) && builtSections.length > 0
            ? builtSections
            : [{ type: 'content', content: message.content, timestamp }],
        timestamp,
      })
    }
    return Promise.resolve()
  }

  public onAssistantMessage(
    context: PresentationContext,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.collectMessage(context.sessionId, message, signal)
  }

  public onToolMessage(
    context: PresentationContext,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.collectMessage(context.sessionId, message, signal)
  }

  public append(message: DisplayMessage): void {
    this.#messages.push(structuredClone(message))
  }

  #markRunStart(sessionId: string): void {
    if (this.#runSessionId !== sessionId) {
      this.#runSessionId = sessionId
      this.#runStartedAt = this.#now()
    }
  }
}
