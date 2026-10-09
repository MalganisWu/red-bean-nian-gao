import { type RawMessage } from 'red-bean-qing-tuan/pipeline'
import type { ChildExecutionIdentity } from '../../../../src/modules/agent/subagent/run/port/child-execution-lifecycle.port.js'
import type { SubExecutionRecord } from '../../../../src/modules/agent/subagent/model/sub-execution.js'
import {
  SUB_EXECUTION_STORE_ERROR_CODES,
  SubExecutionStoreError,
} from '../../../../src/modules/agent/subagent/model/sub-execution.js'
import type { SubExecutionRepository } from '../../../../src/modules/agent/subagent/repository/port/sub-execution-repository.port.js'
import type { AgentExecutionOutcome } from '../../../../src/modules/agent/execution/port/agent-executor.js'
import { RuntimeStateCodec } from '../../../../src/modules/agent/execution/adapter/runtime-state-codec.js'
import { runtimeState } from '../../../helpers/runtime-state.js'

export const SIGNAL = new AbortController().signal

export const RUNTIME_STATE = new RuntimeStateCodec()

export class MemorySubExecutionRepository implements SubExecutionRepository {
  readonly #records = new Map<string, SubExecutionRecord>()
  public afterListPending: (() => Promise<void>) | undefined

  public create(record: SubExecutionRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.#records.has(record.executionId))
      return Promise.reject(new Error('duplicate execution'))
    this.#records.set(record.executionId, structuredClone(record))
    return Promise.resolve()
  }

  public getById(
    executionId: string,
    signal: AbortSignal
  ): Promise<SubExecutionRecord | undefined> {
    signal.throwIfAborted()
    const record = this.#records.get(executionId)
    return Promise.resolve(record === undefined ? undefined : structuredClone(record))
  }

  public async listPending(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly SubExecutionRecord[]> {
    signal.throwIfAborted()
    const snapshot = [...this.#records.values()]
      .filter((record): boolean => record.sessionId === sessionId && record.status === 'pending')
      .map((record): SubExecutionRecord => structuredClone(record))
    await this.afterListPending?.()
    return snapshot
  }

  public listBySession(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly SubExecutionRecord[]> {
    signal.throwIfAborted()
    const snapshot = [...this.#records.values()]
      .filter((record): boolean => record.sessionId === sessionId)
      .map((record): SubExecutionRecord => structuredClone(record))
    return Promise.resolve(snapshot)
  }

  public claimPending(
    executionId: string,
    revision: bigint,
    signal: AbortSignal
  ): Promise<SubExecutionRecord> {
    signal.throwIfAborted()
    const existing = this.#records.get(executionId)
    if (existing === undefined || existing.revision !== revision || existing.status !== 'pending') {
      return Promise.reject(
        new SubExecutionStoreError(
          SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
          'sub execution recovery claim conflict'
        )
      )
    }
    existing.revision += 1n
    existing.updatedAt = new Date()
    return Promise.resolve(structuredClone(existing))
  }

  public update(record: SubExecutionRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const existing = this.#records.get(record.executionId)
    if (existing === undefined || existing.revision !== record.revision) {
      return Promise.reject(
        new SubExecutionStoreError(
          SUB_EXECUTION_STORE_ERROR_CODES.REVISION_CONFLICT,
          'sub execution revision conflict'
        )
      )
    }
    record.revision += 1n
    this.#records.set(record.executionId, structuredClone(record))
    return Promise.resolve()
  }

  public claimResume(
    record: SubExecutionRecord,
    leaseExpiredBefore: Date,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const existing = this.#records.get(record.executionId)
    if (
      existing === undefined ||
      existing.revision !== record.revision ||
      (existing.status !== 'interrupted' &&
        existing.status !== 'awaiting_user' &&
        !(existing.status === 'running' && existing.updatedAt < leaseExpiredBefore))
    ) {
      return Promise.reject(
        new SubExecutionStoreError(
          SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
          'sub execution resume conflict'
        )
      )
    }
    record.revision += 1n
    this.#records.set(record.executionId, structuredClone(record))
    return Promise.resolve()
  }

  public renewResumeLease(
    executionId: string,
    revision: bigint,
    renewedAt: Date,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const existing = this.#records.get(executionId)
    if (existing === undefined || existing.revision !== revision || existing.status !== 'running') {
      return Promise.reject(
        new SubExecutionStoreError(
          SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
          'sub execution resume lease conflict'
        )
      )
    }
    existing.updatedAt = renewedAt
    return Promise.resolve()
  }

  public appendRecoveryMessage(
    executionId: string,
    revision: bigint,
    message: RawMessage,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const existing = this.#records.get(executionId)
    if (
      existing === undefined ||
      existing.revision !== revision ||
      (existing.status !== 'pending' && existing.status !== 'running')
    ) {
      return Promise.reject(
        new SubExecutionStoreError(
          SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
          'sub execution message owner conflict'
        )
      )
    }
    existing.recoveryMessages.push(structuredClone(message))
    return Promise.resolve()
  }
}

export function identity(options: {
  readonly executionId: string
  readonly sessionId?: string
  readonly userId?: string
  readonly requestId?: string
  readonly messages?: readonly RawMessage[]
  readonly interruptId?: string | undefined
}): ChildExecutionIdentity {
  return {
    executionId: options.executionId,
    sessionId: options.sessionId ?? 'session-1',
    userId: options.userId ?? 'user-1',
    requestId: options.requestId ?? 'request-1',
    agentId: 'agent-1',
    parentCallId: '',
    messages: options.messages ?? [],
    ...(options.interruptId === undefined ? {} : { interruptId: options.interruptId }),
  }
}

export function pending(
  executionId: string,
  createdAt: Date = new Date('2026-09-04T00:00:00.000Z')
): SubExecutionRecord {
  return {
    executionId,
    sessionId: 'session-1',
    requestId: 'request-1',
    agentId: 'agent-1',
    agentName: '',
    userId: 'user-1',
    userMessage: '',
    display: [],
    recoveryMessages: [],
    tokensUsed: 0,
    elapsedMilliseconds: 0,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    revision: 0n,
  }
}

export function assistantToolCall(callId: string, toolName: string): RawMessage {
  return {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: callId, type: 'function', function: { name: toolName, arguments: '{}' } }],
  }
}

export function outcome(messages: readonly RawMessage[], tokensUsed = 0): AgentExecutionOutcome {
  return {
    status: 'completed',
    output: messages.at(-1)?.content ?? '',
    messages,
    state: runtimeState(messages),
    tokensUsed,
    finishReason: 'stop',
  }
}
