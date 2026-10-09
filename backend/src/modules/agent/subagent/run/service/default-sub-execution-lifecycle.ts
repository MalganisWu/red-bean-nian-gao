import type { AgentExecutionOutcome } from '../../../execution/port/agent-executor.js'
import type { StoredRuntimeState } from '../../../execution/model/runtime-state.js'
import type { AgentMessage } from '../../../model/agent-message.js'
import type { AgentJsonObject, AgentJsonValue } from '../../../model/json-value.js'
import { validateAndFix } from '../../../session/service/ask-card.js'
import type {
  ChildExecutionLease,
  ChildExecutionIdentity,
  ChildExecutionLifecycle,
} from '../port/child-execution-lifecycle.port.js'
import {
  SUB_EXECUTION_STATUSES,
  SUB_EXECUTION_STORE_ERROR_CODES,
  SubExecutionStoreError,
  type SubExecutionRecord,
  type SubExecutionStatus,
} from '../../model/sub-execution.js'
import type { SubExecutionRepository } from '../../repository/port/sub-execution-repository.port.js'
import { RevisionHeartbeatLease } from './revision-heartbeat-lease.js'
import {
  buildSubExecutionDisplay,
  executionStatus,
  firstUserMessage,
  isJsonValue,
  lastAssistantContent,
  type BuildSubExecutionDisplayRequest,
  updateCompletedRecord,
} from './sub-execution-result.js'

const RESUME_LEASE_MILLISECONDS = 30 * 60 * 1_000
const RESUME_HEARTBEAT_MILLISECONDS = 10 * 60 * 1_000

export interface SubExecutionDisplayPublisher {
  publish(data: AgentJsonObject): void
}

export interface SubExecutionLifecycleOptions {
  readonly agentId: string
  readonly agentName: string
  readonly modelName?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly now?: (() => Date) | undefined
  readonly resumeLeaseMilliseconds?: number | undefined
  readonly resumeHeartbeatMilliseconds?: number | undefined
  readonly displayPublisher?: SubExecutionDisplayPublisher | undefined
}

/**
 * 单次子 Runtime 执行的产品生命周期。
 * 它只编排恢复、终态映射和持久化；SQL 与 row 转换由 Repository Adapter 独占。
 */
export class SubExecutionLifecycle implements ChildExecutionLifecycle {
  readonly #repository: SubExecutionRepository
  readonly #options: SubExecutionLifecycleOptions
  readonly #now: () => Date

  public constructor(repository: SubExecutionRepository, options: SubExecutionLifecycleOptions) {
    this.#repository = repository
    this.#options = options
    this.#now = options.now ?? (() => new Date())
  }

  /** 创建或校验子执行，并返回 Runtime 恢复所需的状态与崩溃增量。 */
  public async load(
    identity: ChildExecutionIdentity,
    resume: boolean,
    signal: AbortSignal
  ): Promise<{
    readonly state?: StoredRuntimeState | undefined
    readonly recoveryMessages: readonly AgentMessage[]
    readonly persistenceRevision?: bigint | undefined
    readonly lease?: ChildExecutionLease | undefined
  }> {
    signal.throwIfAborted()
    const executionId = identity.executionId
    if (executionId === '') throw new Error('子执行 execution_id 不能为空')
    const existing = await this.#repository.getById(executionId, signal)
    if (existing === undefined) {
      if (resume) throw new Error(`子执行 ${JSON.stringify(executionId)} 不存在或不属于当前会话`)
      const created = this.#newRecord(identity, this.#now())
      await this.#repository.create(created, signal)
      return { recoveryMessages: [], persistenceRevision: created.revision }
    }
    if (
      existing.sessionId !== identity.sessionId ||
      existing.userId !== identity.userId ||
      existing.agentId !== identity.agentId
    ) {
      throw new Error(`子执行 ${JSON.stringify(executionId)} 不存在或不属于当前会话`)
    }
    if (!resume) throw new Error(`子执行 ${JSON.stringify(executionId)} 已存在`)
    if (existing.runtimeState === undefined) {
      throw new Error(`子执行 ${JSON.stringify(executionId)} 没有可恢复的 Runtime 状态`)
    }
    if (
      identity.interruptId === undefined ||
      identity.interruptId === '' ||
      identity.interruptId !== existing.pendingInterruptId
    ) {
      throw new Error(`子执行 ${JSON.stringify(executionId)} 的 interrupt ID 无效或已过期`)
    }
    if (
      existing.status !== SUB_EXECUTION_STATUSES.INTERRUPTED &&
      existing.status !== SUB_EXECUTION_STATUSES.AWAITING_USER &&
      existing.status !== SUB_EXECUTION_STATUSES.RUNNING
    ) {
      throw new Error(`子执行 ${JSON.stringify(executionId)} 当前状态不允许恢复`)
    }
    existing.status = SUB_EXECUTION_STATUSES.RUNNING
    const claimedAt = this.#now()
    existing.updatedAt = claimedAt
    existing.completedAt = undefined
    await this.#repository.claimResume(
      existing,
      new Date(claimedAt.valueOf() - RESUME_LEASE_MILLISECONDS),
      signal
    )
    const lease = new RevisionHeartbeatLease(
      this.#repository,
      executionId,
      existing.revision,
      this.#options.resumeLeaseMilliseconds ?? RESUME_LEASE_MILLISECONDS,
      this.#options.resumeHeartbeatMilliseconds ?? RESUME_HEARTBEAT_MILLISECONDS,
      this.#now
    )
    return {
      state: existing.runtimeState,
      recoveryMessages: validateAndFix(existing.recoveryMessages, identity.interruptId ?? ''),
      persistenceRevision: existing.revision,
      lease,
    }
  }

  /** 将中性执行结果提交为产品记录，提交成功后才清理增量缓冲。 */
  public async save(
    identity: ChildExecutionIdentity,
    outcome: AgentExecutionOutcome | undefined,
    displaySections: AgentJsonValue | undefined,
    executionError: Error | undefined,
    persistenceRevision: bigint | undefined,
    lease: ChildExecutionLease | undefined,
    signal: AbortSignal
  ): Promise<void> {
    try {
      signal.throwIfAborted()
      if (lease?.signal.aborted === true) {
        throw new SubExecutionStoreError(
          SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
          `保存子执行 ${JSON.stringify(identity.executionId)} 时 resume lease 已失效`
        )
      }
      if (identity.executionId === '') return
      const now = this.#now()
      const existing = await this.#repository.getById(identity.executionId, signal)
      if (existing === undefined) throw new Error('保存子执行时记录不存在')
      if (persistenceRevision === undefined || existing.revision !== persistenceRevision) {
        throw new SubExecutionStoreError(
          SUB_EXECUTION_STORE_ERROR_CODES.REVISION_CONFLICT,
          `保存子执行 ${JSON.stringify(identity.executionId)} 时 revision 冲突`
        )
      }
      const buffered = validateAndFix(existing.recoveryMessages)
      const messages = outcome?.messages ?? buffered
      const statusAndError = executionStatus(outcome, executionError)
      const resultSummary = lastAssistantContent(messages)
      const display = this.#display(identity, displaySections, statusAndError.status, resultSummary)
      updateCompletedRecord(
        existing,
        identity,
        now,
        statusAndError.status,
        statusAndError.errorMessage,
        outcome?.interrupt?.id,
        resultSummary,
        display,
        messages,
        outcome?.state,
        outcome?.tokensUsed ?? 0,
        this.#options
      )
      await this.#repository.update(existing, signal)
    } finally {
      lease?.release()
    }
  }

  #newRecord(identity: ChildExecutionIdentity, now: Date): SubExecutionRecord {
    const record: SubExecutionRecord = {
      executionId: identity.executionId,
      sessionId: identity.sessionId,
      requestId: identity.requestId,
      agentId: this.#options.agentId,
      agentName: this.#options.agentName,
      userId: identity.userId,
      userMessage: firstUserMessage(identity.messages),
      ...(this.#options.systemPrompt === undefined || this.#options.systemPrompt === ''
        ? {}
        : { systemPrompt: this.#options.systemPrompt }),
      display: [],
      recoveryMessages: [],
      ...(this.#options.modelName === undefined || this.#options.modelName === ''
        ? {}
        : { modelName: this.#options.modelName }),
      tokensUsed: 0,
      elapsedMilliseconds: 0,
      status: SUB_EXECUTION_STATUSES.PENDING,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      revision: 0n,
    }
    return identity.parentCallId === ''
      ? record
      : { ...record, parentCallId: identity.parentCallId }
  }

  #display(
    identity: ChildExecutionIdentity,
    sections: AgentJsonValue | undefined,
    status: SubExecutionStatus,
    resultSummary: string
  ): AgentJsonValue | undefined {
    if (identity.parentCallId === '' || sections === undefined || !isJsonValue(sections)) {
      return undefined
    }
    const displayRequest: BuildSubExecutionDisplayRequest = {
      agentId: this.#options.agentId,
      agentName: this.#options.agentName,
      executionId: identity.executionId,
      parentCallId: identity.parentCallId,
      sections,
      status,
      ...(resultSummary === '' ? {} : { resultSummary }),
    }
    const data = buildSubExecutionDisplay(displayRequest)
    this.#options.displayPublisher?.publish(data)
    return data
  }
}
