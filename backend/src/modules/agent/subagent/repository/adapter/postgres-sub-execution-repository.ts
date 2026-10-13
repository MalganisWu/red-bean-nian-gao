import type { SqlExecutor } from '../../../../../infra/database/postgres.js'
import type { AgentMessage } from '../../../model/agent-message.js'
import { serializeAgentMessage } from '../../../serialization/agent-message-serializer.js'
import {
  SUB_EXECUTION_STATUSES,
  SUB_EXECUTION_STORE_ERROR_CODES,
  SubExecutionStoreError,
  type SubExecutionRecord,
} from '../../model/sub-execution.js'
import type { SubExecutionRepository } from '../port/sub-execution-repository.port.js'
import {
  mapSubExecutionRow,
  SUB_EXECUTION_COLUMNS,
  subExecutionValues,
} from '../persistence/sub-execution-row-mapper.js'

/** PostgreSQL 子执行仓储；负责 SQL、row 校验和基础设施错误上下文。 */
export class PostgresSubExecutionRepository implements SubExecutionRepository {
  /** 注入的 SQL 执行器；全部读写经它下发，中止信号一并透传。 */
  readonly #database: SqlExecutor

  public constructor(database: SqlExecutor) {
    this.#database = database
  }

  /**
   * 插入一条新的子执行记录；主键冲突等基础设施错误补上操作上下文后抛出。
   *
   * @param record - 待落库的领域记录；revision 等字段由调用方初始化
   * @param signal - SQL 中止信号
   */
  public async create(record: SubExecutionRecord, signal: AbortSignal): Promise<void> {
    try {
      await this.#database.query(
        `INSERT INTO sub_agent_executions (${SUB_EXECUTION_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
        subExecutionValues(record),
        signal
      )
    } catch (cause: unknown) {
      throw contextualError('创建子执行记录失败', cause)
    }
  }

  /**
   * 按执行 ID 读取子执行记录；不存在返回 undefined 而不是抛错，交由调用方决定语义。
   *
   * @param executionId - 子执行 ID
   * @param signal - SQL 中止信号
   * @returns 命中则为领域记录，未命中为 undefined
   */
  public async getById(
    executionId: string,
    signal: AbortSignal
  ): Promise<SubExecutionRecord | undefined> {
    try {
      const result = await this.#database.query(
        `SELECT ${SUB_EXECUTION_COLUMNS} FROM sub_agent_executions WHERE execution_id = $1`,
        [executionId],
        signal
      )
      const row = result.rows[0]
      return row === undefined ? undefined : mapSubExecutionRow(row)
    } catch (cause: unknown) {
      throw contextualError('查询子执行记录失败', cause)
    }
  }

  /**
   * 列出会话内仍为 pending 的子执行，供恢复流程收束。
   *
   * @param sessionId - 会话 ID
   * @param signal - SQL 中止信号
   * @returns pending 状态的记录；无则为空数组
   */
  public async listPending(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly SubExecutionRecord[]> {
    try {
      const result = await this.#database.query(
        `SELECT ${SUB_EXECUTION_COLUMNS}
         FROM sub_agent_executions
         WHERE session_id = $1 AND status = $2`,
        [sessionId, SUB_EXECUTION_STATUSES.PENDING],
        signal
      )
      return result.rows.map((row: unknown): SubExecutionRecord => mapSubExecutionRow(row))
    } catch (cause: unknown) {
      throw contextualError('查询待恢复子执行记录失败', cause)
    }
  }

  /**
   * 按创建时间升序列出会话的全部子执行记录；行经信任边界校验后映射。
   *
   * @param sessionId - 会话 ID
   * @param signal - SQL 中止信号
   * @returns 会话内的子执行记录，按 created_at 升序
   */
  public async listBySession(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly SubExecutionRecord[]> {
    try {
      const result = await this.#database.query(
        `SELECT ${SUB_EXECUTION_COLUMNS}
         FROM sub_agent_executions
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [sessionId],
        signal
      )
      return result.rows.map((row: unknown): SubExecutionRecord => mapSubExecutionRow(row))
    } catch (cause: unknown) {
      throw contextualError('查询会话子执行记录失败', cause)
    }
  }

  /**
   * 以 revision CAS 认领一条 pending 子执行：成功则 revision 自增并返回新记录。
   * 行未命中（已被他人认领或 revision 不符）时抛 RESUME_CONFLICT，绝不覆盖他人认领。
   *
   * @param executionId - 子执行 ID
   * @param revision - 期望的当前 revision；不符即冲突
   * @param signal - SQL 中止信号
   * @returns 认领后的记录，revision 已自增
   */
  public async claimPending(
    executionId: string,
    revision: bigint,
    signal: AbortSignal
  ): Promise<SubExecutionRecord> {
    try {
      const result = await this.#database.query(
        `UPDATE sub_agent_executions
         SET revision = revision + 1, updated_at = now()
         WHERE execution_id = $1 AND revision = $2 AND status = 'pending'
         RETURNING ${SUB_EXECUTION_COLUMNS}`,
        [executionId, revision],
        signal
      )
      const row = result.rows[0]
      if (row !== undefined) return mapSubExecutionRow(row)
    } catch (cause: unknown) {
      throw contextualError('认领待恢复子执行记录失败', cause)
    }
    throw new SubExecutionStoreError(
      SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
      `子执行 ${executionId} 已被其他恢复流程认领`
    )
  }

  /**
   * 以 revision CAS 认领续跑：仅当状态为可恢复态，或 running 且 updated_at 早于租期阈值时成功。
   * 未命中抛 RESUME_CONFLICT——旧 owner 的租约未过期时不得抢占。
   *
   * @param record - 待认领的记录；其 revision 作为 CAS 期望值
   * @param leaseExpiredBefore - 判定 running 记录租约已过期的时刻阈值
   * @param signal - SQL 中止信号
   */
  public async claimResume(
    record: SubExecutionRecord,
    leaseExpiredBefore: Date,
    signal: AbortSignal
  ): Promise<void> {
    if (
      await this.#conditionalUpdate(
        record,
        ` AND (status IN ('interrupted', 'awaiting_user')
               OR (status = 'running' AND updated_at < $19))`,
        [leaseExpiredBefore],
        signal
      )
    ) {
      return
    }
    throw new SubExecutionStoreError(
      SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
      `子执行 ${record.executionId} 已被其他请求恢复`
    )
  }

  /**
   * 以 revision CAS 整体更新记录；成功后把新 revision 写回 `record`。
   * revision 不符时抛 REVISION_CONFLICT，防止覆盖他人的写入。
   *
   * @param record - 待写回的记录（含期望 revision）；成功后就地更新其 revision
   * @param signal - SQL 中止信号
   */
  public async update(record: SubExecutionRecord, signal: AbortSignal): Promise<void> {
    if (await this.#conditionalUpdate(record, '', [], signal)) return
    throw new SubExecutionStoreError(
      SUB_EXECUTION_STORE_ERROR_CODES.REVISION_CONFLICT,
      `子执行 ${record.executionId} revision 冲突`
    )
  }

  /**
   * 续租续跑所有权：把 updated_at 前移到 renewedAt（仅当 revision 匹配且状态仍为 running）。
   * 未命中抛 RESUME_CONFLICT——续不上即说明所有权已不属于自己。
   *
   * @param executionId - 子执行 ID
   * @param revision - 期望的当前 revision
   * @param renewedAt - 新的租约时刻，作为 updated_at 写入
   * @param signal - SQL 中止信号
   */
  public async renewResumeLease(
    executionId: string,
    revision: bigint,
    renewedAt: Date,
    signal: AbortSignal
  ): Promise<void> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `UPDATE sub_agent_executions
         SET updated_at = $1
         WHERE execution_id = $2 AND revision = $3 AND status = 'running'`,
        [renewedAt, executionId, revision],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError('续租子执行失败', cause)
    }
    if (result.rowCount > 0) return
    throw new SubExecutionStoreError(
      SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
      `子执行 ${executionId} 的 resume lease 已失效`
    )
  }

  /**
   * 以 revision CAS 追加一条恢复消息（仅 pending / running 状态）；JSONB 追加，不重写历史。
   * 未命中抛 RESUME_CONFLICT，避免旧 owner 把消息写进已被接管的记录。
   *
   * @param executionId - 子执行 ID
   * @param revision - 期望的当前 revision
   * @param message - 待追加的会话消息，序列化后并入 recovery_messages
   * @param signal - SQL 中止信号
   */
  public async appendRecoveryMessage(
    executionId: string,
    revision: bigint,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `UPDATE sub_agent_executions
         SET recovery_messages = recovery_messages || $1::jsonb,
             updated_at = now()
         WHERE execution_id = $2 AND revision = $3 AND status IN ('pending', 'running')`,
        [JSON.stringify([serializeAgentMessage(message)]), executionId, revision],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError('追加子执行恢复消息失败', cause)
    }
    if (result.rowCount > 0) return
    throw new SubExecutionStoreError(
      SUB_EXECUTION_STORE_ERROR_CODES.RESUME_CONFLICT,
      `子执行 ${executionId} 的消息写入 owner 已失效`
    )
  }

  /**
   * 以 revision CAS 整体更新记录；多个写路径共用的底层实现。
   * 未命中任何行时不抛错而是返回 false，由调用方决定抛哪种冲突码。
   *
   * @param record - 待写回的记录；其 revision 进 WHERE 做 CAS，成功后就地增量。
   * @param statusClause - 追加到 WHERE 的状态限制片段，空串表示不限状态。
   * @param extraParameters - statusClause 里占位符对应的参数，按顺序追加到 SQL 参数尾部。
   * @param signal - SQL 中止信号。
   * @returns 写入并成功取回新 revision 时为 true；未命中行为 false。
   */
  async #conditionalUpdate(
    record: SubExecutionRecord,
    statusClause: string,
    extraParameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      const result = await this.#database.query(
        `UPDATE sub_agent_executions SET
          agent_name = $1, user_message = $2, system_prompt = $3, display_messages = $4::jsonb,
          runtime_state = $5::jsonb, recovery_messages = $6::jsonb, model_name = $7,
          tokens_used = $8, elapsed_ms = $9, status = $10, pending_interrupt_id = $11,
          result_summary = $12, error_msg = $13, parent_call_id = $14, updated_at = $15,
          completed_at = $16,
          revision = revision + 1
         WHERE execution_id = $17 AND revision = $18${statusClause}
         RETURNING revision`,
        [
          record.agentName,
          record.userMessage,
          record.systemPrompt ?? null,
          JSON.stringify(record.display),
          record.runtimeState === undefined ? null : JSON.stringify(record.runtimeState),
          JSON.stringify(record.recoveryMessages.map(serializeAgentMessage)),
          record.modelName ?? null,
          record.tokensUsed,
          record.elapsedMilliseconds,
          record.status,
          record.pendingInterruptId ?? null,
          record.resultSummary ?? null,
          record.errorMessage ?? null,
          record.parentCallId ?? null,
          record.updatedAt,
          record.completedAt ?? null,
          record.executionId,
          record.revision,
          ...extraParameters,
        ],
        signal
      )
      if (result.rowCount === 0) return false
      const row = result.rows[0]
      if (typeof row !== 'object' || row === null || !('revision' in row)) {
        throw new Error('子执行更新未返回 revision')
      }
      const revision = row['revision']
      if (
        typeof revision !== 'string' &&
        typeof revision !== 'number' &&
        typeof revision !== 'bigint'
      ) {
        throw new Error('子执行更新返回了非法 revision')
      }
      record.revision = BigInt(revision)
      return true
    } catch (cause: unknown) {
      if (cause instanceof SubExecutionStoreError) throw cause
      throw contextualError('更新子执行记录失败', cause)
    }
  }
}

/**
 * 统一包装仓储错误：保留中文上下文前缀，并把原始错误挂在 `cause` 上。
 * 不丢 cause 是硬要求——只取 message 重抛会让日志与观测断链，排障时定位不到根因。
 *
 * @param context - 中文上下文前缀，说明是哪一步操作失败。
 * @param cause - 原始错误；不是 Error 时按其字符串形式保留 message。
 * @returns 带 cause 链的新错误。
 */
function contextualError(context: string, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  return new Error(`${context}: ${error.message}`, { cause })
}
