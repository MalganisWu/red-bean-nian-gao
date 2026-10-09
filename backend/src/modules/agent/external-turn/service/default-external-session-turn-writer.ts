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
  readonly #sessions: FencedSessionRepository
  readonly #locks: SessionLockRegistry
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

function containsExternalId(messages: readonly DisplayMessage[], externalId: string): boolean {
  return messages.some(
    (message): boolean => message.meta?.scheduledTask?.executionId === externalId
  )
}

function hasPendingCard(messages: readonly DisplayMessage[]): boolean {
  return messages.some((message): boolean => containsPendingCard(message.sections))
}

function containsPendingCard(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item): boolean => containsPendingCard(item))
  if (!isRecord(value)) return false
  const card = value['card']
  if (value['type'] === 'card' && isRecord(card) && card['status'] === 'pending') return true
  return Object.values(value).some((item): boolean => containsPendingCard(item))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function newLeaseOwner(sessionId: string): string {
  return `external-turn:${sessionId}:${randomBytes(12).toString('hex')}`
}
