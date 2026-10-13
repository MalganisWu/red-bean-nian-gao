import { randomBytes } from 'node:crypto'

import type { RuntimeStateAppender } from '../../execution/port/runtime-state-appender.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { DisplayMessage } from '../../presentation/model/display-message.js'
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type SessionLockRegistry,
} from '../../session/lock/port/session-lock.js'
import type { FencedSessionRepository } from '../../session/repository/port/session-repository.port.js'
import type {
  ExternalSessionTurn,
  ExternalSessionTurnWriteResult,
  ExternalSessionTurnWriterPort,
} from '../port/external-session-turn-writer.port.js'

/** 外部回合写入默认实现；一次写入完整持有并释放 Session lease。 */
export class DefaultExternalSessionTurnWriter implements ExternalSessionTurnWriterPort {
  /** 会话仓储；写入与 fence 推进都通过它完成。 */
  readonly #sessions: FencedSessionRepository
  /** 会话锁注册表；未携带 fencing token 时用它取 lease。 */
  readonly #locks: SessionLockRegistry
  /** 运行时状态追加器；把本轮消息并入会话的 runtimeState。 */
  readonly #runtimeState: RuntimeStateAppender

  public constructor(
    sessions: FencedSessionRepository,
    locks: SessionLockRegistry,
    runtimeState: RuntimeStateAppender
  ) {
    this.#sessions = sessions
    this.#locks = locks
    this.#runtimeState = runtimeState
  }

  /**
   * 写入外部回合：优先沿用请求携带的 fencingToken，否则尝试获取 Session lease。
   * 拿不到 lease 或会话仍有 pending 卡片时返回 `deferred`；externalId 已存在返回 `duplicate`；
   * 正常写入返回 `written`。一次写入完整持有并释放 lease，避免并发回合互相覆盖。
   * @param turn 外部回合数据，含 sessionId 与展示 / 运行时消息
   * @param signal 中止信号，透传给仓储与锁
   * @returns 写入结果：`written` / `deferred` / `duplicate`
   */
  public async write(
    turn: ExternalSessionTurn,
    signal: AbortSignal
  ): Promise<ExternalSessionTurnWriteResult> {
    if (turn.fencingToken !== undefined)
      return this.#writeUnderFence(turn, turn.fencingToken, signal)
    const lease = await this.#tryAcquire(turn.sessionId, signal)
    if (lease === undefined) return 'deferred'
    try {
      return await this.#writeUnderFence(turn, lease.fencingToken, signal)
    } finally {
      await lease.release()
    }
  }

  /**
   * 在已持 fence 的前提下写入：推进 fence、识别重复投递与未完卡片，再合并并保存会话。
   * 会话仍有 pending 卡片时返回 `deferred`，避免外部回合插到未决卡片之前。
   * @param turn 外部回合数据；含 sessionId、externalId 与要并入的展示 / 运行消息
   * @param fencingToken 已持有的 fence，undefined 表示不推进 fence（沿用调用方 lease）
   * @param signal 中止信号，透传给仓储
   * @returns 写入结果：`written` / `duplicate` / `deferred`
   */
  async #writeUnderFence(
    turn: ExternalSessionTurn,
    fencingToken: bigint | undefined,
    signal: AbortSignal
  ): Promise<ExternalSessionTurnWriteResult> {
    const session = await this.#sessions.getOrCreate(turn.sessionId, turn.userId, signal)
    if (fencingToken !== undefined) {
      await this.#sessions.advanceFence(turn.sessionId, turn.userId, fencingToken, signal)
      session.fencingToken = fencingToken
    }
    if (hasPendingCard(session.displayMessages)) return 'deferred'
    if (containsExternalId(session.displayMessages, turn.externalId)) return 'duplicate'
    session.displayMessages.push(...structuredClone(turn.displayMessages))
    const runtimeMessages: AgentMessage[] = []
    if (turn.userContent !== '') runtimeMessages.push({ role: 'user', content: turn.userContent })
    if (turn.assistantContent !== '') {
      runtimeMessages.push({ role: 'assistant', content: turn.assistantContent })
    }
    session.runtimeState = this.#runtimeState.appendMessages(session.runtimeState, runtimeMessages)
    await this.#sessions.save(session, signal)
    return 'written'
  }

  /**
   * 尝试获取会话 lease；锁冲突返回 undefined（交由调用方按 `deferred` 处理），其余错误上抛。
   * @param sessionId 目标会话标识
   * @param signal 中止信号，透传给锁注册表
   * @returns 已获取的 lease；锁冲突时为 undefined
   */
  async #tryAcquire(sessionId: string, signal: AbortSignal) {
    try {
      return await this.#locks.tryAcquire(sessionId, newLeaseOwner(sessionId), signal)
    } catch (cause: unknown) {
      if (cause instanceof RegistryError && cause.code === REGISTRY_ERROR_CODES.LOCK_CONFLICT) {
        return undefined
      }
      throw new Error('获取外部回合 Session 锁失败', { cause })
    }
  }
}

/**
 * 判定会话既有展示消息里是否已带该 externalId，用于识别重复投递。
 * @param messages 会话已有展示消息序列
 * @param externalId 外部调度的执行标识，写入时会落在消息 meta.scheduledTask.executionId
 * @returns 已存在该 externalId 时为 true
 */
function containsExternalId(messages: readonly DisplayMessage[], externalId: string): boolean {
  return messages.some(
    (message): boolean => message.meta?.scheduledTask?.executionId === externalId
  )
}

/**
 * 判定会话是否仍有待处理的交互卡片；有则拒绝写入，避免外部回合插到未决卡片之前。
 * @param messages 会话已有展示消息序列
 * @returns 任一消息的 sections 里存在 pending 卡片时为 true
 */
function hasPendingCard(messages: readonly DisplayMessage[]): boolean {
  return messages.some((message): boolean => containsPendingCard(message.sections))
}

/**
 * 深度遍历任意 JSON 值，查找 status 为 pending 的 card。
 * 卡片可能嵌在 sections 的任意层级，故按结构递归而非只看顶层，避免漏判。
 * @param value 待检查的值；类型未知故逐层窄化
 * @returns 含有 pending 卡片时为 true
 */
function containsPendingCard(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item): boolean => containsPendingCard(item))
  if (!isRecord(value)) return false
  const card = value['card']
  if (value['type'] === 'card' && isRecord(card) && card['status'] === 'pending') return true
  return Object.values(value).some((item): boolean => containsPendingCard(item))
}

/**
 * 判定值是否为非数组的普通对象，用于把 unknown 窄化到可按键访问。
 * @param value 待判定值
 * @returns 是对象且非 null、非数组时为 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 生成外部回合专用的 lease owner 标识。
 * 带随机串是刻意的：同一 session 的并发写入者必须能互相区分，否则后到者会被误判为同一持有者。
 * @param sessionId 会话标识
 * @returns 形如 external-turn:<sessionId>:<随机十六进制> 的 owner 字符串
 */
function newLeaseOwner(sessionId: string): string {
  return `external-turn:${sessionId}:${randomBytes(12).toString('hex')}`
}
