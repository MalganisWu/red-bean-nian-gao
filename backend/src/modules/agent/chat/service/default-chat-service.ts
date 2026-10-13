import type { IdGenerator } from '../../../../shared/id/id-generator.js'
import type { CancelRegistryPort } from '../../cancellation/port/cancellation-registry.port.js'
import type { AnswerMarker } from '../../session/model/session.js'
import type { AgentRunServicePort } from '../../run/port/agent-run-service.port.js'
import type { AgentRunRequest } from '../../run/model/agent-run.js'
import type {
  AnswerChatCommand,
  CancelChatCommand,
  StartedChatRun,
  StartChatCommand,
} from '../model/chat-command.js'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'
import type { ChatRunLifecyclePort, ChatUseCasePort } from '../port/chat-use-case.port.js'
import { ChatUseCaseError } from '../port/chat-use-case.port.js'
import type { ChatRunHandle } from '../stream/chat-run-handle.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

interface ActiveRun {
  readonly handle: ChatRunHandle
  readonly cleanup: Promise<void>
}

/**
 * 一次运行启动的完整输入：认证上下文 + 已解析的本轮消息，缺省标识已由服务补齐。
 * 具名类型让 `#startRun` 的参数不再是无名结构——调用点读方法名即可知道传的是什么。
 */
interface ChatRunInput {
  readonly userId: string
  readonly traceId: string
  readonly signal: AbortSignal
  readonly sessionId: string
  readonly agentId: string
  readonly messages: StartChatCommand['messages']
  readonly answer?: AnswerMarker | undefined
}

/**
 * Chat 用例默认实现：统一拥有消息选择、ID、取消注册和活动运行生命周期。
 */
export class DefaultChatService implements ChatUseCasePort, ChatRunLifecyclePort {
  readonly #runService: AgentRunServicePort
  readonly #cancelRegistry: CancelRegistryPort
  readonly #idGenerator: IdGenerator
  readonly #activeRuns = new Map<string, ActiveRun>()
  readonly #startingRuns = new Set<Promise<StartedChatRun>>()
  readonly #shutdownController = new AbortController()
  #draining = false

  public constructor(options: {
    readonly runService: AgentRunServicePort
    readonly cancelRegistry: CancelRegistryPort
    readonly idGenerator: IdGenerator
  }) {
    this.#runService = options.runService
    this.#cancelRegistry = options.cancelRegistry
    this.#idGenerator = options.idGenerator
  }

  /**
   * 发起新一轮对话。前置要求：会话需有本轮 user 消息（否则拒绝）；缺省 sessionId/agentId 补默认值。
   *
   * @param command - 发起命令；messages 必须含本轮 user 消息，另有 userId 决定取消键与归属。
   * @returns 启动后的运行句柄与首帧 start 事件；启动中登记进 `#startingRuns` 以便停机排空。
   */
  public start(command: StartChatCommand): Promise<StartedChatRun> {
    const messages = selectMessagesForTurn(command.messages, command.sessionId)
    if (messages.length === 0) {
      throw new ChatUseCaseError('missing_user_message', '已有会话缺少本轮 user 消息')
    }
    return this.#trackStart(this.#startRun(this.#newRunInput(command, messages)))
  }

  /**
   * 回答询问卡片：把答案包装为 AnswerMarker 走 resume 语义；回答路径不携带新消息。
   *
   * @param command - 回答命令；interactionId 必填，answers 缺省视为空对象、refused 缺省视为否。
   * @returns 恢复出的运行句柄与首帧 start 事件，与 `start` 共用同一套登记与清理。
   */
  public answer(command: AnswerChatCommand): Promise<StartedChatRun> {
    return this.#trackStart(this.#startRun(this.#resumeRunInput(command)))
  }

  /**
   * 取消单个请求：走取消注册表（按 userId+requestId），不作用于整个会话。
   *
   * @param command - 取消命令；userId 与 requestId 共同构成取消键，缺一不可定位目标运行。
   */
  public async cancel(command: CancelChatCommand): Promise<void> {
    await this.#cancelRegistry.cancel(cancelRegistryKey(command.userId, command.requestId))
  }

  /**
   * 停机排空：置 draining（拒绝新启动）→ 中止所有活动运行 → 等启动中与清理全部落地；
   * 每个阶段受外部 signal 约束，超时由调用方处理，不无限等待。
   *
   * `#closeActiveRuns()` **调用两次**是必要的，不是重复：第一次处理此刻已在运行的；
   * 而在等待 `startingRuns` 期间，某个「正在启动」的运行可能恰好完成启动并注册进 `#activeRuns`。
   * 第二次调用把这一批也收进来。少了它，停机时正在启动的那次会漏掉。
   *
   * 中止信号是内部 `#shutdownController`，不是调用方传进来的：后者只用来限制**等待时长**，
   * 不该决定「哪些运行要停」。
   *
   * @param signal - 调用方的等待上限信号；只约束本方法等多久，不决定要停哪些运行，已中止则立即抛出。
   */
  public async shutdown(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.#draining = true
    this.#shutdownController.abort(new Error('Chat 服务正在停机'))
    const finalizations = this.#closeActiveRuns()
    await raceWithAbort(
      Promise.allSettled([...this.#startingRuns]).then((): void => {}),
      signal
    )
    finalizations.push(...this.#closeActiveRuns())
    await raceWithAbort(
      Promise.all(finalizations).then((): void => {}),
      signal
    )
  }

  /** 新会话运行输入：缺省 sessionId/agentId 在此一次补齐，字段与 `ChatRunInput` 逐一对应。 */
  #newRunInput(command: StartChatCommand, messages: ChatRunInput['messages']): ChatRunInput {
    return {
      userId: command.userId,
      traceId: command.traceId,
      signal: command.signal,
      sessionId: command.sessionId ?? this.#idGenerator.generate('SESS'),
      agentId: command.agentId ?? 'default',
      messages,
    }
  }

  /** 恢复运行输入：回答路径不携带新消息，答案归一化为 AnswerMarker。 */
  #resumeRunInput(command: AnswerChatCommand): ChatRunInput {
    return {
      userId: command.userId,
      traceId: command.traceId,
      signal: command.signal,
      sessionId: command.sessionId,
      agentId: command.agentId ?? 'default',
      messages: [],
      answer: {
        interactionId: command.interactionId,
        answers: command.answers ?? {},
        refused: command.refused === true,
      },
    }
  }

  async #startRun(command: ChatRunInput): Promise<StartedChatRun> {
    if (this.#draining) throw new Error('Chat 服务正在停机')
    const runId = this.#idGenerator.generate('RUN')
    const key = cancelRegistryKey(command.userId, runId)
    let signal: AbortSignal
    try {
      // 把运行信号与取消注册表绑定：其他请求可通过 cancel 中止本运行；
      // 注册失败（如取消竞态）直接抛出，不启动孤儿运行。
      signal = await this.#cancelRegistry.wrap(
        AbortSignal.any([command.signal, this.#shutdownController.signal]),
        key
      )
    } catch (cause: unknown) {
      throw normalizeError(cause)
    }

    let handle: ChatRunHandle
    try {
      const startRequest: AgentRunRequest = {
        agentId: command.agentId,
        sessionId: command.sessionId,
        userId: command.userId,
        runId,
        traceId: command.traceId,
        messages: command.messages,
        ...optionalField('answer', command.answer),
      }
      handle = await this.#runService.start(startRequest, signal)
    } catch (cause: unknown) {
      // 启动失败必须注销取消键，否则注册表条目泄漏、后续 cancel 会误伤。
      await this.#deregisterQuietly(key)
      throw cause
    }

    const cleanup = this.#cleanupRun(runId, key, handle)
    this.#activeRuns.set(runId, { handle, cleanup })
    return {
      start: {
        type: 'start',
        requestId: runId,
        sessionId: command.sessionId,
        traceId: command.traceId,
      },
      handle,
    }
  }

  /**
   * 把「启动中」的运行登记下来，只为让停机时能等它落地。
   * 从集合里摘除的时机写在 `finally` 里而不是 `then`：启动失败的运行同样要摘掉，
   * 否则它会永远留在集合里，停机时白等一个已 reject 的 Promise。
   * 末尾那个空 `catch` 是为了消费掉这条派生链上的拒绝——原始 Promise 仍会正常抛给调用方。
   */
  #trackStart(starting: Promise<StartedChatRun>): Promise<StartedChatRun> {
    this.#startingRuns.add(starting)
    void starting
      .finally((): void => {
        this.#startingRuns.delete(starting)
      })
      .catch((): void => {})
    return starting
  }

  #closeActiveRuns(): Promise<void>[] {
    return [...this.#activeRuns.values()].map((run): Promise<void> => closeActiveRun(run))
  }

  async #cleanupRun(runId: string, key: string, handle: ChatRunHandle): Promise<void> {
    await handle.completion
    await this.#deregisterQuietly(key)
    this.#activeRuns.delete(runId)
  }

  async #deregisterQuietly(key: string): Promise<void> {
    try {
      await this.#cancelRegistry.deregister(key)
    } catch {
      // 运行结果优先于取消注册清理错误；Redis TTL 仍会提供最终兜底。
    }
  }
}

/**
 * 取消键 = 用户 + 请求；带上 userId 是为了让不同用户的同 requestId 不会互相取消。
 *
 * @param userId - 发起该请求的用户标识，保证取消作用域不跨用户。
 * @param requestId - 运行标识（首帧 start 事件的 requestId），同一用户内唯一。
 * @returns 注册表使用的取消键字符串，注册与注销两处必须用同一算法生成。
 */
export function cancelRegistryKey(userId: string, requestId: string): string {
  return `${userId}:${requestId}`
}

/**
 * 新会话保留完整种子消息；已有会话只接受本轮最后一条用户消息，避免客户端重复提交历史。
 *
 * @param messages - 客户端提交的完整消息列表，可能夹带历史轮次。
 * @param sessionId - 已有会话标识；缺省表示新会话，此时整份种子原样透传。
 * @returns 该轮真正要落库的消息数组；已有会话无 user 消息时返回空数组，由调用方判空拒绝。
 */
export function selectMessagesForTurn(
  messages: StartChatCommand['messages'],
  sessionId?: string
): StartChatCommand['messages'] {
  if (sessionId === undefined) return [...messages]
  for (const message of messages.toReversed()) {
    if (message.role === 'user') return [message]
  }
  return []
}

/** 关停单个活动运行：先关句柄再等它自己的清理落地。 */
async function closeActiveRun(run: ActiveRun): Promise<void> {
  await run.handle.close('server_shutdown')
  await run.cleanup
}

function raceWithAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))

  /**
   * executor：operation 的落地与 signal 的中止谁先到谁兑现；
   * 任一条路径先到都摘掉中止监听，不在调用方传进来的 signal 上留下监听器。
   */
  function settleAgainstAbort(resolve: () => void, reject: (reason?: unknown) => void): void {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })

    /** operation 成功落地：摘掉中止监听并放行等待。 */
    function onResolved(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }

    /** operation 失败落地：摘掉中止监听并透传归一化错误。 */
    function onRejected(cause: unknown): void {
      signal.removeEventListener('abort', onAbort)
      reject(normalizeError(cause))
    }

    void operation.then(onResolved, onRejected)
  }

  return new Promise<void>(settleAgainstAbort)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Chat shutdown aborted')
}
