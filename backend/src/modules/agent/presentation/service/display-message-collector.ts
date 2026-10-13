import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentJsonValue } from '../../model/json-value.js'
import type { DisplayMessage } from '../model/display-message.js'

/** 取当前时间戳（epoch 毫秒）；可注入，测试因此能产出确定的时间。 */
export interface PresentationClock {
  (): number
}

/** 构造选项；`buildSections` 用于把当次运行累积的 section 挂到 assistant 消息上。 */
export interface DisplayMessageCollectorOptions {
  /** 时间戳来源；缺省用 `Date.now`，注入后测试可产出确定的时间。 */
  readonly now?: PresentationClock | undefined
  /**
   * 构造当次运行 section 的方法；缺省则 assistant 消息只带正文分节。
   * @returns 当次运行的 section 值；收集器挂到 assistant 消息上，非数组或空则退回正文分节。
   */
  readonly buildSections?: (() => AgentJsonValue) | undefined
}

/** Runtime 回调携带的上下文；`metadata` 是节点之间共享的可变袋。 */
export interface PresentationContext {
  /** 当前运行的会话标识；与上次不同即视为一次新运行的起点。 */
  readonly sessionId: string
  /** 节点之间共享的可变元数据袋；展示历史快照也写在这里。 */
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
  /** 时间戳来源；可注入，测试据此产出确定的时间。 */
  readonly #now: PresentationClock
  /**
   * 构造当次运行 section 的方法；缺省则只产出正文分节。
   * @returns 当次运行的 section 值；非数组或空时退回正文分节。
   */
  readonly #buildSections: (() => AgentJsonValue) | undefined
  /** 已收集的展示消息；对外经 `messages` getter 深拷贝返回。 */
  readonly #messages: DisplayMessage[] = []
  /** 本次运行开始时间（epoch 毫秒）；会话切换时刷新。 */
  #runStartedAt = 0
  /** 当前运行归属的会话标识；用来识别运行起点。 */
  #runSessionId = ''

  public constructor(options: DisplayMessageCollectorOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#buildSections = options.buildSections
  }

  /**
   * 当前已收集的展示消息快照。
   * 返回值经 `structuredClone` 深拷贝：调用方修改它不会影响收集器内部状态。
   * @returns 展示消息的只读快照副本
   */
  public get messages(): readonly DisplayMessage[] {
    return structuredClone(this.#messages)
  }

  /**
   * Runtime user 消息回调；触发时机为 Runtime 提交一条 user 消息时。
   * 用 `context.sessionId` 标记 run 起点后转发给 collectMessage。
   * @param context Runtime 回调上下文，提供本次运行的 sessionId
   * @param message Runtime 提交的消息
   * @param signal 中止信号；已中止则立即抛出
   */
  public onUserMessage(
    context: PresentationContext,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.collectMessage(context.sessionId, message, signal)
  }

  /**
   * 供高层 Runtime Adapter 使用，避免业务层为了展示投影构造 RuntimeContext。
   * @param sessionId 当前运行会话 ID；与上次不同即视为一次新运行的起点，刷新 runStartedAt
   * @param message Runtime 提交的消息；仅非空 user 正文与无 toolCalls 的 assistant 正文会入列
   * @param signal 中止信号；入口先 `throwIfAborted`，中止时不产生任何展示消息
   */
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

  /**
   * Runtime assistant 消息回调；触发时机为 Runtime 提交一条 assistant 消息时。
   * 只有正文非空且不带 toolCalls 的才算「已完成的助手内容」，其余（工具轮次的协议结构）不入列。
   * @param context Runtime 回调上下文，提供本次运行的 sessionId
   * @param message Runtime 提交的 assistant 消息
   * @param signal 中止信号；已中止则立即抛出
   */
  public onAssistantMessage(
    context: PresentationContext,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.collectMessage(context.sessionId, message, signal)
  }

  /**
   * Runtime tool 消息回调；触发时机为 Runtime 提交一条 tool 消息时。
   * tool 信封只保留在 LLM context，展示层不接收，因此这里只走统一的 run 起点标记。
   * @param context Runtime 回调上下文，提供本次运行的 sessionId
   * @param message Runtime 提交的 tool 消息
   * @param signal 中止信号；已中止则立即抛出
   */
  public onToolMessage(
    context: PresentationContext,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.collectMessage(context.sessionId, message, signal)
  }

  /**
   * 直接追加一条展示消息（深拷贝后入列），供中断卡片投影等非 Runtime 回调路径使用。
   * @param message 待追加的展示消息；入列前 `structuredClone`，外部后续修改不影响内部
   */
  public append(message: DisplayMessage): void {
    this.#messages.push(structuredClone(message))
  }

  /**
   * 标记运行起点：会话标识与上次不同时刷新 `runStartedAt`，让后续消息归入新一次运行。
   * @param sessionId 当前运行会话 ID；与上次相同则不做任何改动
   */
  #markRunStart(sessionId: string): void {
    if (this.#runSessionId !== sessionId) {
      this.#runSessionId = sessionId
      this.#runStartedAt = this.#now()
    }
  }
}
