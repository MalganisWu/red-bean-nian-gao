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

/** 活动运行登记项：运行句柄，以及句柄关闭后仍需等待的清理 Promise。 */
interface ActiveRun {
  /** 运行句柄；停机与清理都从它入手。 */
  readonly handle: ChatRunHandle
  /** 句柄关闭后仍需等待的清理 Promise；等它兑现才能安全释放资源。 */
  readonly cleanup: Promise<void>
}

/**
 * 一次运行启动的完整输入：认证上下文 + 已解析的本轮消息，缺省标识已由服务补齐。
 * 具名类型让 `#startRun` 的参数不再是无名结构——调用点读方法名即可知道传的是什么。
 */
interface ChatRunInput {
  /** 发起该运行的用户标识；决定运行归属与取消键。 */
  readonly userId: string
  /** 链路追踪标识；透传到运行与日志。 */
  readonly traceId: string
  /** 客户端请求的中止信号；断连时据此通知运行收尾。 */
  readonly signal: AbortSignal
  /** 本次运行的会话标识；缺省已由服务补齐。 */
  readonly sessionId: string
  /** 本次运行的 agent 标识；缺省已由服务补齐。 */
  readonly agentId: string
  /** 本轮要落库的消息；已是服务筛选后的结果。 */
  readonly messages: StartChatCommand['messages']
  /** 人工交互的回答标记；仅 answer 路径携带。 */
  readonly answer?: AnswerMarker | undefined
}

/**
 * Chat 用例默认实现：统一拥有消息选择、ID、取消注册和活动运行生命周期。
 */
export class DefaultChatService implements ChatUseCasePort, ChatRunLifecyclePort {
  /** 运行服务；一次流式运行的实际启动与收尾入口。 */
  readonly #runService: AgentRunServicePort
  /** 取消注册表；绑定运行信号，使其他请求能跨实例取消本运行。 */
  readonly #cancelRegistry: CancelRegistryPort
  /** ID 生成器；缺省会话标识与运行 ID 都从它取。 */
  readonly #idGenerator: IdGenerator
  /** 已启动且仍在运行的活动登记；停机时逐个收束。 */
  readonly #activeRuns = new Map<string, ActiveRun>()
  /** 正在启动中的运行；停机时需要等它们落地，避免漏掉刚注册的运行。 */
  readonly #startingRuns = new Set<Promise<StartedChatRun>>()
  /** 停机时用于中止所有活动运行的内部控制器，独立于调用方传入的信号。 */
  readonly #shutdownController = new AbortController()
  /** 是否正在停机；置真后拒绝一切新的启动请求。 */
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

  /**
   * 新会话运行输入：缺省 sessionId/agentId 在此一次补齐，字段与 `ChatRunInput` 逐一对应。
   * @param command 发起命令；缺省 sessionId/agentId 会在此补为生成值与默认 agent
   * @param messages 本轮已筛选好的消息；原样写入运行输入
   * @returns 字段齐备的运行输入，供 `#startRun` 使用
   */
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

  /**
   * 恢复运行输入：回答路径不携带新消息，答案归一化为 AnswerMarker。
   * @param command 回答命令；answers 缺省补空对象、refused 缺省视否
   * @returns 字段齐备的运行输入，messages 恒为空数组
   */
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

  /**
   * 启动一次运行：绑定取消键、调用运行服务、登记活跃项，并组装首帧 start 事件。
   * 启动失败必须注销取消键，否则注册表条目泄漏、后续 cancel 会误伤。
   * @param command 已补齐缺省的运行输入；含身份、消息与可选的回答标记
   * @returns 运行句柄与首帧 start 事件
   */
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
   *
   * @param starting 待登记的启动中 Promise
   * @returns 原样的启动中 Promise，调用方仍可直接 await
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

  /**
   * 收束当前所有活动运行，返回它们各自的清理 Promise 供停机方等待。
   * 只做「关停」不等待：调用方拿到全部清理 Promise 后才决定等多久。
   * @returns 每个活动运行对应的清理 Promise 数组
   */
  #closeActiveRuns(): Promise<void>[] {
    return [...this.#activeRuns.values()].map((run): Promise<void> => closeActiveRun(run))
  }

  /**
   * 运行收尾清理：等句柄完成、注销取消键、再从活动表摘除。
   * 顺序不可颠倒——先等完成再注销，避免运行仍在途时取消键就被清掉。
   * @param runId 运行标识；用于从活动表摘除
   * @param key 该运行的取消键；运行结束后注销
   * @param handle 运行句柄；以其 completion 作为收尾完成信号
   */
  async #cleanupRun(runId: string, key: string, handle: ChatRunHandle): Promise<void> {
    await handle.completion
    await this.#deregisterQuietly(key)
    this.#activeRuns.delete(runId)
  }

  /**
   * 尽力注销取消键：注销失败只吞掉不抛出。
   * 运行结果优先于取消注册清理错误，Redis TTL 仍会提供最终兜底。
   * @param key 待注销的取消键
   */
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

/**
 * 关停单个活动运行：先关句柄再等它自己的清理落地。
 * @param run 待关停的活动运行登记项；先 `close` 再等其 `cleanup` 兑现
 */
async function closeActiveRun(run: ActiveRun): Promise<void> {
  await run.handle.close('server_shutdown')
  await run.cleanup
}

/**
 * 让一个操作与中止信号赛跑，谁先到谁兑现，并保证不在调用方的 signal 上留下监听器。
 * 中止先到时以归一化后的中止原因拒绝，用于把「等多久」与「停哪些运行」分开表达。
 * @param operation 待等待的操作，成功或失败都透传（失败经 `normalizeError`）
 * @param signal 中止信号；已中止或等待期间触发都会以中止原因拒绝
 */
function raceWithAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))

  // executor：operation 的落地与 signal 的中止谁先到谁兑现；
  // 任一条路径先到都摘掉中止监听，不在调用方传进来的 signal 上留下监听器。
  function settleAgainstAbort(resolve: () => void, reject: (reason?: unknown) => void): void {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })

    // operation 成功落地：摘掉中止监听并放行等待。
    function onResolved(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }

    // operation 失败落地：摘掉中止监听并透传归一化错误。
    function onRejected(cause: unknown): void {
      signal.removeEventListener('abort', onAbort)
      reject(normalizeError(cause))
    }

    void operation.then(onResolved, onRejected)
  }

  return new Promise<void>(settleAgainstAbort)
}

/**
 * 取中止信号携带的原因，非 Error 的取值折叠为固定文案，保证调用方总能拿到 Error。
 * @param signal 已中止的信号，其 reason 由 abort 时的入参决定
 * @returns 归一化后的中止原因
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('对话关闭已中止')
}
