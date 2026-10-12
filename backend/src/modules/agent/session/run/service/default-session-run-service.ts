import type { AgentMessage } from '../../../model/agent-message.js'
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type SessionLease,
  type SessionLockRegistry,
} from '../../lock/port/session-lock.js'
import type { DisplayMessage } from '../../../presentation/model/display-message.js'

import { SESSION_STORE_ERROR_CODES, SessionStoreError } from '../../model/session.js'
import type {
  FencedSessionRepository,
  SessionRepository,
} from '../../repository/port/session-repository.port.js'
import type {
  MessageBuffer,
  MessageBufferGeneration,
} from '../../message-buffer/port/message-buffer.port.js'
import {
  buildAnswerToolResult,
  findPendingCard,
  hasPendingCard,
  mergeContinuation,
  resolveCard,
  validateAndFix,
} from '../../service/ask-card.js'
import type {
  SessionLoadRequest,
  SessionRunOutcome,
  SessionRunServicePort,
  SessionRunState,
} from '../port/session-run-service.port.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

const ASK_USER_TOOL_NAME = 'sys_ask_user'

/**
 * 围绕一次 Runtime 执行负责产品会话的加载、恢复与保存。
 * 并发语义（三条防线，缺一不可）：
 * 1. session 锁（可选）：跨实例互斥，锁携带 fencingToken 与 writeProof；
 * 2. fencing token：单调推进，旧实例的写入资格随 token 失效；
 * 3. revision CAS：repository.save 以预期 revision 守卫，冲突显式失败。
 * 增量消息写入"revision + writeProof"组成的 buffer generation，成功保存后才清除；
 * 运行中断时 generation 保留，作为下次加载的恢复来源。
 */
export class SessionLifecycle implements SessionRunServicePort {
  readonly #repository: SessionRepository
  readonly #buffer: MessageBuffer
  readonly #locks: SessionLockRegistry | undefined

  public constructor(
    repository: SessionRepository,
    buffer: MessageBuffer,
    locks?: SessionLockRegistry
  ) {
    this.#repository = repository
    this.#buffer = buffer
    this.#locks = locks
  }

  /**
   * 加载会话运行状态：拿锁 → 恢复/创建会话 → 推进 fencing → 组装恢复消息与 resume 参数。
   * 失败语义：锁冲突/交互冲突抛用户可读错误；任何失败都会释放已取得的锁。
   */
  public async load(request: SessionLoadRequest, signal: AbortSignal): Promise<SessionRunState> {
    const lock = await this.#acquire(request, signal)
    try {
      const session = await this.#repository.getOrCreate(request.sessionId, request.userId, signal)
      // 锁的 fencingToken 非零时单调推进：旧 token 实例的写入资格在此失效；
      // 不支持 fencing 的存储（如内存仓库）在需要推进时显式报错，避免静默绕过防线。
      const fencingToken = lock?.fencingToken ?? session.fencingToken
      if (fencingToken !== 0n) {
        if (!isFencedRepository(this.#repository)) {
          throw new Error('session repository 不支持 fencing')
        }
        await this.#repository.advanceFence(request.sessionId, request.userId, fencingToken, signal)
        session.fencingToken = fencingToken
      }

      // 以"进入加载时的 revision"作为本次 generation 与保存 CAS 的基准：
      // 加载后其他实例的写入会改变 revision，保存时由 CAS 拒绝而不是在这里竞争。
      const checkpointRevision = session.revision
      // 上次运行中断未提交的增量消息保留在 buffer 中；识别悬挂的 ask_user 调用
      // （有 tool call 无 tool result），恢复时按卡片语义校验与修补。
      const staleMessages = await this.#buffer.peekGeneration(
        request.checkpointId,
        sessionGeneration(checkpointRevision, lock?.writeProof),
        signal
      )
      const interruptCallId = danglingToolCallId(staleMessages, ASK_USER_TOOL_NAME)
      const recoveryMessages = validateAndFix(staleMessages, interruptCallId)
      let resume: SessionRunState['resume']
      if (request.answer !== undefined) {
        // interrupt 应答：卡片必须仍存在，否则视为"已处理过"的重复请求。
        const card = findPendingCard(session.displayMessages, request.answer.interactionId)
        if (card === undefined) throw interactionConflict(request.answer.interactionId)
        resume = {
          interruptId: request.answer.interactionId,
          response: buildAnswerToolResult(card, request.answer),
        }
      } else if (hasPendingCard(session.displayMessages)) {
        // 有未应答卡片时禁止发起新一轮运行：复用 run API 会绕过卡片回答路径。
        throw new SessionStoreError(
          SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT,
          '会话存在待回答的询问卡片'
        )
      }

      for (const message of request.messages) {
        await this.#buffer.appendGeneration(
          request.checkpointId,
          sessionGeneration(checkpointRevision, lock?.writeProof),
          message,
          signal
        )
      }

      return {
        ...request,
        checkpointRevision,
        fencingToken,
        ...(lock?.writeProof === undefined ? {} : { bufferWriteProof: lock.writeProof }),
        runtimeState: session.runtimeState,
        recoveryMessages,
        ...optionalField('resume', resume),
        displayMessages: structuredClone(session.displayMessages),
        ...optionalField('lock', lock),
        ...(lock?.lost === undefined ? {} : { leaseLost: lock.lost }),
      }
    } catch (cause: unknown) {
      await releaseQuietly(lock)
      throw cause
    }
  }

  /**
   * 保存一次运行的结果。lease 已丢失时拒绝持久化（写入资格已失效，落库会破坏 fencing 语义）；
   * 执行成功走完成路径，否则走恢复路径；无论成败都释放锁。
   */
  public async save(
    state: SessionRunState,
    outcome: SessionRunOutcome,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const leaseError = await settledLeaseError(state.leaseLost)
      if (leaseError !== undefined) {
        throw new Error('拒绝持久化已丢失 lease 的 session', { cause: leaseError })
      }
      if (outcome.executionError === undefined) {
        await this.#saveCompleted(state, outcome, signal)
      } else {
        await this.#saveRecovery(state, outcome, signal)
      }
    } finally {
      await releaseQuietly(state.lock)
    }
  }

  /** 获取 session 锁：LOCK_CONFLICT 翻译为"他人处理中"的用户可读错误，其余失败按基础设施错误上抛。 */
  async #acquire(
    request: SessionLoadRequest,
    signal: AbortSignal
  ): Promise<SessionLease | undefined> {
    if (this.#locks === undefined) return undefined
    try {
      return await this.#locks.tryAcquire(request.sessionId, request.runId, signal)
    } catch (cause: unknown) {
      if (cause instanceof RegistryError && cause.code === REGISTRY_ERROR_CODES.LOCK_CONFLICT) {
        throw new Error(`session ${request.sessionId} 正在被其他请求处理，请稍后重试`, {
          cause,
        })
      }
      throw new Error('获取 session 锁失败', { cause })
    }
  }

  /**
   * 完成路径：展示消息按"是否回答卡片"合并，runtimeState 覆盖保存；
   * repository.save 以 revision CAS 守卫（冲突即失败），成功后才清除 buffer generation——
   * 崩溃在 save 之前的话，增量消息仍留在 buffer 里可恢复。
   */
  async #saveCompleted(
    state: SessionRunState,
    outcome: SessionRunOutcome,
    signal: AbortSignal
  ): Promise<void> {
    const session = await this.#repository.getOrCreate(state.sessionId, state.userId, signal)
    session.revision = state.checkpointRevision
    session.fencingToken = state.fencingToken
    if (state.answer !== undefined) {
      const resolved = resolveCard(session.displayMessages, state.answer)
      session.displayMessages = mergeContinuation(
        resolved,
        state.answer.interactionId,
        outcome.displayMessages
      )
    } else {
      session.displayMessages = [
        ...session.displayMessages,
        ...structuredClone(outcome.displayMessages),
      ]
    }
    if (outcome.runtimeState !== undefined)
      session.runtimeState = structuredClone(outcome.runtimeState)
    await this.#repository.save(session, signal)
    await this.#buffer.clearGeneration(state.checkpointId, stateGeneration(state), signal)
  }

  /**
   * 恢复路径（执行失败/中断）：buffer 无增量且无 answer 时无可恢复内容，清空即返回；
   * 否则保存部分进展（runtimeState + 用户输入），失败消息仍以 buffer generation 保留。
   */
  async #saveRecovery(
    state: SessionRunState,
    outcome: SessionRunOutcome,
    signal: AbortSignal
  ): Promise<void> {
    const buffered = await this.#buffer.peekGeneration(
      state.checkpointId,
      stateGeneration(state),
      signal
    )
    if (buffered.length === 0 && state.answer === undefined) {
      await this.#buffer.clearGeneration(state.checkpointId, stateGeneration(state), signal)
      return
    }
    const session = await this.#repository.getOrCreate(state.sessionId, state.userId, signal)
    session.revision = state.checkpointRevision
    session.fencingToken = state.fencingToken
    if (outcome.runtimeState !== undefined)
      session.runtimeState = structuredClone(outcome.runtimeState)
    if (state.answer !== undefined) {
      session.displayMessages = resolveCard(session.displayMessages, state.answer)
    } else {
      // 首轮被取消时 Runtime 可能尚未来得及回调用户消息；仍需保存用户已经提交的输入，
      // 避免刷新后只留下一个标题为“新会话”的空 Session。
      session.displayMessages = [
        ...session.displayMessages,
        ...recoveryUserMessages(state, outcome.displayMessages),
      ]
    }
    await this.#repository.save(session, signal)
    await this.#buffer.clearGeneration(state.checkpointId, stateGeneration(state), signal)
  }
}

/** generation = revision + 锁的 writeProof：writeProof 区分同一 revision 下不同持有者的写入域。 */
function sessionGeneration(revision: bigint, writeProof?: string): MessageBufferGeneration {
  return { revision, ...optionalField('writeProof', writeProof) }
}

function stateGeneration(state: SessionRunState): MessageBufferGeneration {
  return sessionGeneration(state.checkpointRevision, state.bufferWriteProof)
}

/** 恢复用户输入：优先用本次已收集的用户消息，否则回退到请求原始输入（避免刷新后空会话）。 */
function recoveryUserMessages(
  state: SessionRunState,
  collected: readonly DisplayMessage[]
): readonly DisplayMessage[] {
  const collectedUsers = collected.filter((message): boolean => message.role === 'user')
  if (collectedUsers.length > 0) return structuredClone(collectedUsers)
  const timestamp = Date.now()
  return state.messages.flatMap((message): readonly DisplayMessage[] =>
    message.role === 'user' && message.content !== null && message.content !== ''
      ? [{ role: 'user', content: message.content, timestamp }]
      : []
  )
}

/** 找上次运行中断留下的 ask_user 调用：有 tool call 无对应 tool result 的调用即悬挂。 */
function danglingToolCallId(messages: readonly AgentMessage[], toolName: string): string {
  const completed = new Set(
    messages
      .filter((message): boolean => message.role === 'tool' && message.toolCallId !== undefined)
      .map((message): string => message.toolCallId ?? '')
  )
  for (const message of messages.toReversed()) {
    for (const call of (message.toolCalls ?? []).toReversed()) {
      if (call.function.name === toolName && !completed.has(call.id)) return call.id
    }
  }
  return ''
}

/**
 * 运行期能力探测：仓储是否支持 fencing。
 * 用结构判断而不是让 Port 自己声明，是因为 `SessionRepository` 是结构性类型——
 * 内存实现天然没有 `advanceFence`，而生产实现有；让调用方在这里显式分流，
 * 比逼所有实现都提供一个「我不支持」的空方法要干净。
 * 判据是「方法存在且可调用」，而不是单纯 `in`：属性存在但为 undefined 同样不可用。
 */
function isFencedRepository(repository: SessionRepository): repository is FencedSessionRepository {
  return 'advanceFence' in repository && typeof repository.advanceFence === 'function'
}

function interactionConflict(interactionId: string): SessionStoreError {
  return new SessionStoreError(
    SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT,
    `交互 ${interactionId} 不存在或已处理`
  )
}

/** 等 lease 丢失信号"已定局"：race 一个立即 resolve 的 undefined，避免永久等待。 */
async function settledLeaseError(lost: Promise<Error> | undefined): Promise<Error | undefined> {
  if (lost === undefined) return undefined
  return Promise.race([lost, Promise.resolve(undefined)])
}

async function releaseQuietly(lock: SessionLease | undefined): Promise<void> {
  if (lock === undefined) return
  try {
    await lock.release()
  } catch {
    // 尽力释放失败不能覆盖本次运行的主要结果或主要错误。
  }
}
