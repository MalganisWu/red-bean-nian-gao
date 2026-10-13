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

/** resume 租期与心跳；心跳取租期的 1/3，连续两次续租失败后仍有 1/3 租期可用。 */
const RESUME_LEASE_MILLISECONDS = 30 * 60 * 1_000
/**
 * resume 心跳间隔（10 分钟），取 resume 租期的三分之一：
 * 连续两次续租失败后仍留有三分之一租期可用，避免单次抖动就丢租。
 * 可经 `SubExecutionLifecycleOptions.resumeHeartbeatMilliseconds` 覆盖。
 */
const RESUME_HEARTBEAT_MILLISECONDS = 10 * 60 * 1_000

/** 把子执行的展示数据交给父运行的回调；父运行据此把子结果折进自己的展示流。 */
export interface SubExecutionDisplayPublisher {
  /**
   * 发布一次子执行的展示载荷，交由父运行折进自己的展示流。
   *
   * @param data - 落库用的子执行展示载荷。
   */
  publish(data: AgentJsonObject): void
}

/** 生命周期选项；`now` 与租期/心跳均可注入，测试因此不必真等满 30 分钟。 */
export interface SubExecutionLifecycleOptions {
  /** 子 Agent 定义标识；写入新建记录。 */
  readonly agentId: string
  /** 子 Agent 展示名；写入记录并用于渲染分区标题。 */
  readonly agentName: string
  /** 实际使用的模型名；空串或缺省表示不写该字段。 */
  readonly modelName?: string | undefined
  /** 子 Agent 系统提示词；空串或缺省表示不写该字段。 */
  readonly systemPrompt?: string | undefined
  /** 取当前时间的函数；缺省用真实时钟，测试可注入固定值以免真等满租期。 */
  readonly now?: (() => Date) | undefined
  /** resume 租期毫秒数；缺省用 `RESUME_LEASE_MILLISECONDS`。 */
  readonly resumeLeaseMilliseconds?: number | undefined
  /** resume 心跳间隔毫秒数；必须小于租期，缺省用 `RESUME_HEARTBEAT_MILLISECONDS`。 */
  readonly resumeHeartbeatMilliseconds?: number | undefined
  /** 展示发布回调；缺省表示不向父运行发布子执行展示。 */
  readonly displayPublisher?: SubExecutionDisplayPublisher | undefined
}

/**
 * 单次子 Runtime 执行的产品生命周期。
 * 它只编排恢复、终态映射和持久化；SQL 与 row 转换由 Repository Adapter 独占。
 */
export class SubExecutionLifecycle implements ChildExecutionLifecycle {
  /** 子执行仓储；负责 CAS 认领、续租与终态写入。 */
  readonly #repository: SubExecutionRepository
  /** 组装时固定的选项；含 Agent 元信息与可注入的租期/时钟。 */
  readonly #options: SubExecutionLifecycleOptions
  /** 取当前时间的函数；已按选项兜底为真实时钟。 */
  readonly #now: () => Date

  public constructor(repository: SubExecutionRepository, options: SubExecutionLifecycleOptions) {
    this.#repository = repository
    this.#options = options
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * 创建或校验子执行，并返回 Runtime 恢复所需的状态与崩溃增量。
   *
   * 恢复路径是一串有序校验，顺序不能换：**归属**（是不是我的）→ **有状态可恢复** →
   * **interrupt ID 对得上**（且未过期）→ **当前状态允许恢复** → 认领 + 建租约。
   * 把归属放最前是因为它是唯一会「掩盖存在性」的判定，见下。
   *
   * 注意「不存在」与「不属于当前会话」用的是**同一句错误文案**：
   * 区分开会让人用 executionId 探测别人的子执行是否存在。
   *
   * @param identity - 子执行身份；executionId / sessionId / userId 用于归属校验，parentCallId 决定是否保留父关联
   * @param resume - 是否续跑：false 表示新建，true 触发一串恢复校验（归属→有状态→interrupt 匹配→状态允许）
   * @param signal - 中止信号，透传给仓储调用
   * @returns 恢复上下文：新建时仅含 recoveryMessages 与 persistenceRevision；恢复时另含 state 与租约，调用方保存前须检查租约是否失效
   */
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
      // 要恢复一个不存在的子执行：多半是父 Agent 拿了一个过期或别人给的 executionId。
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

  /**
   * 将中性执行结果提交为产品记录，提交成功后才清理增量缓冲。
   *
   * 两道门槛在写入之前：**租约仍然有效**（失效说明别的实例已接管，写进去就是覆盖别人的结果）
   * 与 **revision 未变**（CAS）。
   * 租约的 `release()` 放在 `finally`，且失败路径也走它——否则一次写失败会让心跳定时器一直活着。
   *
   * @param identity - 子执行身份；executionId 为空串时视为无需持久化，直接返回
   * @param outcome - Runtime 执行结果；undefined 表示未拿到结果，按失败处理
   * @param displaySections - 累积的展示 section；缺失或无 parentCallId 时不发布展示
   * @param executionError - 执行期错误；用于映射 errorMessage 与兜底状态
   * @param persistenceRevision - 加载时的 revision，作为 CAS 期望值；不符即冲突
   * @param lease - resume 租约；保存前检查是否失效，写完后在 finally 释放
   * @param signal - 中止信号；进入即先 throwIfAborted
   */
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

  /**
   * 构造一条全新的 pending 子执行记录；只填最小必需字段，终态由后续 update 补齐。
   *
   * @param identity - 子执行身份，提供 id、归属与首条用户消息。
   * @param now - 创建时刻，同时写入 createdAt / updatedAt / completedAt。
   * @returns 可落库的新记录快照。
   */
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

  /**
   * 组装并发布子执行的展示载荷；缺父调用标识、缺 section 或 section 非法时返回 undefined。
   *
   * @param identity - 子执行身份；parentCallId 为空串时不发布展示。
   * @param sections - 累积的展示 section；undefined 或非 JSON 值时视为不可用。
   * @param status - 映射后的产品状态，写入展示载荷。
   * @param resultSummary - 结果摘要；空串表示不写该字段。
   * @returns 落库用的展示载荷；不可用时为 undefined。
   */
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
