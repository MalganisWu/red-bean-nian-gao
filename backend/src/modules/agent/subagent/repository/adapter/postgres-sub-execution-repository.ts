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
  readonly #database: SqlExecutor

  public constructor(database: SqlExecutor) {
    this.#database = database
  }

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

  public async update(record: SubExecutionRecord, signal: AbortSignal): Promise<void> {
    if (await this.#conditionalUpdate(record, '', [], signal)) return
    throw new SubExecutionStoreError(
      SUB_EXECUTION_STORE_ERROR_CODES.REVISION_CONFLICT,
      `子执行 ${record.executionId} revision 冲突`
    )
  }

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

function contextualError(context: string, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  return new Error(`${context}: ${error.message}`, { cause })
}
