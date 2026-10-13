import type { AgentMessage } from '../../../model/agent-message.js'
import type { DisplayMessage } from '../../../presentation/model/display-message.js'
import {
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
  type Session,
  type SessionSummary,
} from '../../model/session.js'
import type { FencedSessionRepository } from '../port/session-repository.port.js'
import type {
  MessageBuffer,
  MessageBufferGeneration,
} from '../../message-buffer/port/message-buffer.port.js'

/**
 * 测试使用的内存消息缓冲实现；复制输入输出，避免调用方共享可变数组所有权。
 *
 * 进出都 `structuredClone`：写入时复制，读出时也复制。只做前者的话，
 * 调用方拿到的数组仍与内部状态同一份，一次就地 `push` 就能绕过 `append` 直接改缓冲区，
 * 测试也就测不出真实实现里的隔离问题。
 */
export class MemoryMessageBuffer implements MessageBuffer {
  /** 各会话的缓冲消息；键为 sessionId（分代写入时含代 revision）。 */
  readonly #messages = new Map<string, AgentMessage[]>()

  /**
   * 追加一条消息；写入内部状态的是深拷贝，调用方后续改动原对象不会影响缓冲。
   *
   * @param sessionId - 目标会话标识，决定消息归入哪个键。
   * @param message - 待缓冲的消息；会被结构化拷贝后保存。
   * @param signal - 取消信号；已中止时返回 rejected Promise，而非静默成功。
   */
  public append(sessionId: string, message: AgentMessage, signal: AbortSignal): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const messages = this.#messages.get(sessionId) ?? []
    messages.push(structuredClone(message))
    this.#messages.set(sessionId, messages)
    return Promise.resolve()
  }

  /**
   * 只读窥视缓冲内容，不清除。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   * @returns 内部消息的深拷贝；调用方就地修改不会污染缓冲。
   */
  public peek(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    return Promise.resolve(structuredClone(this.#messages.get(sessionId) ?? []))
  }

  /**
   * 取出并清空缓冲（消费语义）。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 取消信号；已中止时返回 rejected Promise，且不清空缓冲。
   * @returns 本次消费掉的深拷贝消息；重复调用返回空数组。
   */
  public flush(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const messages = structuredClone(this.#messages.get(sessionId) ?? [])
    this.#messages.delete(sessionId)
    return Promise.resolve(messages)
  }

  /**
   * 丢弃整个缓冲；幂等，键不存在时同样成功。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   */
  public clear(sessionId: string, signal: AbortSignal): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    this.#messages.delete(sessionId)
    return Promise.resolve()
  }

  /**
   * 写入某一代缓冲；键里带 revision，各代互不干扰。
   *
   * @param sessionId - 目标会话标识，与 generation 一起决定分代键。
   * @param generation - 目标分代；只用其 `revision` 参与拼键。
   * @param message - 待缓冲的消息。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   */
  public appendGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.append(generationKey(sessionId, generation), message, signal)
  }

  /**
   * 只读窥视某一代缓冲，不清除。
   *
   * @param sessionId - 目标会话标识，与 generation 一起决定分代键。
   * @param generation - 目标分代；只读它对应的键。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   * @returns 该代的深拷贝消息。
   */
  public peekGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]> {
    return this.peek(generationKey(sessionId, generation), signal)
  }

  /**
   * 清除某一代缓冲；键不存在时幂等成功。
   *
   * @param sessionId - 目标会话标识，与 generation 一起决定分代键。
   * @param generation - 目标分代；只删它对应的键。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   */
  public clearGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<void> {
    return this.clear(generationKey(sessionId, generation), signal)
  }
}

/**
 * 在会话键上追加分代 revision，得到内存实现里这一代专属的键；各代因此互不覆盖。
 *
 * @param sessionId - 目标会话标识。
 * @param generation - 目标分代，只用其 `revision` 参与拼键。
 * @returns 该会话该代的缓冲键。
 */
function generationKey(sessionId: string, generation: MessageBufferGeneration): string {
  return `${sessionId}:${generation.revision.toString()}`
}

/**
 * 测试使用的内存 Session 仓储；模拟生产实现的用户隔离、revision CAS 与 fencing 语义。
 *
 * 与 Postgres 版本的两处**刻意不同**，改测试时别把它们当成 bug：
 * - **分页游标是 session id，不是时间戳**。内存实现按 `#order` 的插入序维护，
 *   没有可比较的时间轴，用 id 定位更直接。生产实现见 `PostgresSessionRepository`。
 * - `#order` 在每次 `save` 时把该 id 移到末尾，`listByUser` 再 `toReversed()`，
 *   于是「最近更新的排最前」这件事完全不依赖时钟——测试可以注入固定的 `now`。
 */
export class MemorySessionStore implements FencedSessionRepository {
  /** 会话主存储；键为 session id，值为深拷贝隔离的快照。 */
  readonly #sessions = new Map<string, Session>()
  /** 各会话的最后更新时间；列表摘要取它，写入时机与 `save` 一致。 */
  readonly #updated = new Map<string, Date>()
  /** 更新顺序（最早 → 最新）；读取时反转即为列表顺序。 */
  #order: string[] = []
  /**
   * 取当前时间的函数；默认用真实时钟，测试可注入固定值以消除时间抖动。
   * @returns 当前时刻；写入各会话的更新时间戳，列表排序间接依赖它。
   */
  readonly #now: () => Date

  public constructor(now: () => Date = (): Date => new Date()) {
    this.#now = now
  }

  /**
   * 取得会话，不存在则按给定的 id 与归属创建一个空会话。
   *
   * 已存在但不属于该用户 → `NOT_FOUND`（不是「已存在」），与生产实现的所有权隐藏一致。
   *
   * @param sessionId - 目标会话标识；不存在时以它作为新会话主键。
   * @param userId - 会话归属用户，决定能否读到已有会话。
   * @param signal - 取消信号；已中止时返回 rejected Promise 而不创建。
   * @returns 会话的深拷贝；调用方改动不会影响内部状态。
   */
  public getOrCreate(sessionId: string, userId: string, signal: AbortSignal): Promise<Session> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined) {
      return existing.userId === userId
        ? Promise.resolve(cloneSession(existing))
        : Promise.reject(notFoundError())
    }
    const session: Session = {
      id: sessionId,
      userId,
      displayMessages: [],
      revision: 0n,
      fencingToken: 0n,
    }
    this.#sessions.set(sessionId, cloneSession(session))
    this.#order.push(sessionId)
    this.#updated.set(sessionId, this.#now())
    return Promise.resolve(cloneSession(session))
  }

  /**
   * 按标识读取会话，不创建。
   *
   * 不存在与不属于该用户收敛到同一条 `NOT_FOUND`，调用方无法据错误码探测他人会话。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 归属校验依据；不匹配即视为不存在。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   * @returns 会话的深拷贝。
   */
  public getById(sessionId: string, userId: string, signal: AbortSignal): Promise<Session> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const session = this.#sessions.get(sessionId)
    if (session === undefined || session.userId !== userId) {
      return Promise.reject(notFoundError())
    }
    return Promise.resolve(cloneSession(session))
  }

  /**
   * CAS + fencing 保存。三道校验只在「已存在」时进行；不存在则视为创建，直接写入。
   *
   * 校验顺序与生产实现一致（越权 → revision → fencing），但这里**先判 revision 再判 fencing**：
   * 内存实现里两者不可能同时不符（都是同一个调用方带来的快照），顺序无实际影响；
   * Postgres 版本因为写进同一条 WHERE，需要事后区分，那里顺序才有意义。
   *
   * 注意 `session.revision` 是**就地自增**的：调用方手上的对象会随之更新，
   * 于是同一次会话里的连续保存可以复用同一个对象。
   *
   * @param session - 待保存的会话快照；其 `revision`/`fencingToken` 是 CAS 比较基准，成功后 `revision` 被就地 +1。
   * @param signal - 取消信号；已中止时返回 rejected Promise 且不写入。
   */
  public save(session: Session, signal: AbortSignal): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const current = this.#sessions.get(session.id)
    if (current !== undefined) {
      if (current.userId !== session.userId) return Promise.reject(notFoundError())
      if (current.revision !== session.revision) {
        return Promise.reject(
          new SessionStoreError(
            SESSION_STORE_ERROR_CODES.REVISION_CONFLICT,
            'session revision conflict'
          )
        )
      }
      if (current.fencingToken !== session.fencingToken) {
        return Promise.reject(staleFenceError())
      }
    }

    session.revision += 1n
    this.#sessions.set(session.id, cloneSession(session))
    this.#updated.set(session.id, this.#now())
    // 移到末尾 = 最近更新；`listByUser` 反转后即为「最新在前」。
    this.#order = [...this.#order.filter((id): boolean => id !== session.id), session.id]
    return Promise.resolve()
  }

  /**
   * 推进会话的 fencing 高水位。
   *
   * 高水位只前进：`token < current` 报 `STALE_FENCE`，相等与更大都直接写入。`0n` 为无操作。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 归属校验依据；不匹配即视为不存在。
   * @param token - 新的围栏序号；`0n` 表示「未启用 fencing」，直接返回不做写入。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   */
  public advanceFence(
    sessionId: string,
    userId: string,
    token: bigint,
    signal: AbortSignal
  ): Promise<void> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    if (token === 0n) return Promise.resolve()
    const session = this.#sessions.get(sessionId)
    if (session === undefined || session.userId !== userId) {
      return Promise.reject(notFoundError())
    }
    if (token < session.fencingToken) return Promise.reject(staleFenceError())
    session.fencingToken = token
    return Promise.resolve()
  }

  /**
   * 列出某个用户的会话摘要，按最近更新在前排序。
   *
   * 排序不依赖时钟：`#order` 记录保存顺序，读取时反转；游标因此是 session id 而非时间戳，
   * 这与生产实现（基于 `updated_at` 的键集分页）刻意不同。
   *
   * @param userId - 只返回属于该用户的会话。
   * @param cursor - 上一页末条的 session id；空串表示首页，命不中也从头部开始。
   * @param limit - 页大小；非正数按 20 兜底。
   * @param signal - 取消信号；已中止时返回 rejected Promise。
   * @returns 摘要列表；不含 runtimeState 与完整消息列表。
   */
  public listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly SessionSummary[]> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    const effectiveLimit = limit <= 0 ? 20 : limit
    const sessions = this.#order
      .toReversed()
      .map((id): Session | undefined => this.#sessions.get(id))
      .filter((session): session is Session => session !== undefined && session.userId === userId)
    const cursorIndex =
      cursor === '' ? -1 : sessions.findIndex((session): boolean => session.id === cursor)
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1
    const summaries: SessionSummary[] = []
    for (const session of sessions.slice(start, start + effectiveLimit)) {
      const updatedAt = this.#updated.get(session.id)
      if (updatedAt === undefined) continue
      summaries.push({
        id: session.id,
        title: extractTitle(session.displayMessages),
        messageCount: session.displayMessages.length,
        updatedAt: new Date(updatedAt),
      })
    }
    return Promise.resolve(summaries)
  }
}

/**
 * 深拷贝会话后再交给调用方或存回内部状态。仓储的契约是调用方不得通过返回值直接改到内部状态，
 * 因此进出都要复制；省掉任何一次都会让测试测不出真实实现里的共享可变问题。
 *
 * @param session - 待拷贝的会话。
 * @returns 与原对象不共享引用的副本。
 */
function cloneSession(session: Session): Session {
  return structuredClone(session)
}

/**
 * 取第一条有正文的用户消息作为标题，超过 30 个字符则截断加省略号。
 * 用 `Array.from` 而不是 `slice`：后者按 UTF-16 码元切，会把 emoji 或星形平面的汉字劈成半个。
 * 一条用户消息都没有时返回空串，由展示层决定占位文案。
 *
 * @param messages - 会话的展示消息列表，按时间顺序。
 * @returns 标题；没有可用用户消息时为空串。
 */
function extractTitle(messages: readonly DisplayMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || message.content === undefined) continue
    const characters = Array.from(message.content)
    return characters.length > 30 ? `${characters.slice(0, 30).join('')}...` : message.content
  }
  return ''
}

/**
 * 构造会话不存在的领域错误。越权读与真的不存在收敛到同一条，调用方无法据此探测他人会话。
 *
 * @returns `NOT_FOUND` 类型的 SessionStoreError。
 */
function notFoundError(): SessionStoreError {
  return new SessionStoreError(SESSION_STORE_ERROR_CODES.NOT_FOUND, 'session not found')
}

/**
 * 构造围栏陈旧的领域错误；表示锁已被别的实例接管，调用方应当放弃而不是重试。
 *
 * @returns `STALE_FENCE` 类型的 SessionStoreError。
 */
function staleFenceError(): SessionStoreError {
  return new SessionStoreError(
    SESSION_STORE_ERROR_CODES.STALE_FENCE,
    'session fencing token is stale'
  )
}

/**
 * 把「已取消」转成待拒绝的错误；返回 undefined 表示信号仍有效、调用方可以继续。
 * 优先复用信号自身的 reason，缺省时给出标准的 AbortError，保证取消原因不丢。
 *
 * @param signal - 调用方传入的取消信号。
 * @returns 已中止时为对应错误，否则为 undefined。
 */
function abortFailure(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('operation aborted', 'AbortError')
}
