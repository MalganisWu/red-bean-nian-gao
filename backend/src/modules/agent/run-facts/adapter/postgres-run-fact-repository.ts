import type { SqlExecutor } from '../../../../infra/database/postgres.js'
import type { RunFact } from '../model/run-fact.js'
import {
  SESSION_RUN_SCHEMA_VERSION,
  SESSION_RUN_STATUSES,
  type FinalizeSessionRunCommand,
  type SessionRunRecord,
  type StartSessionRunCommand,
} from '../model/session-run.js'
import type { RunFactRepository } from '../port/run-fact-repository.port.js'
import {
  parseSessionRunRecord,
  SESSION_RUN_ROW_COLUMNS,
} from '../persistence/run-fact-row-mapper.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/**
 * 面向 session_runs 表的事实日志 PostgreSQL adapter。
 * append-only 语义由 SQL 守卫保证：追加与终态化都要求 `ended_at IS NULL`，
 * run_index 用单条 INSERT..SELECT 在会话内分配（配合 session 锁串行化同一会话的 run）。
 */
export class PostgresRunFactRepository implements RunFactRepository {
  readonly #database: SqlExecutor

  public constructor(database: SqlExecutor) {
    this.#database = database
  }

  public async create(run: StartSessionRunCommand, signal: AbortSignal): Promise<SessionRunRecord> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `INSERT INTO session_runs (
          run_id, session_id, user_id, run_index, provider, model, context_window,
          status, started_at, header, facts, schema_version
        )
        SELECT $1, $2::varchar, $3, COALESCE(MAX(run_index) + 1, 0), $4, $5, $6,
               'running', $7, $8::jsonb, '[]'::jsonb, $9
        FROM session_runs
        WHERE session_id = $2::varchar
        RETURNING run_index`,
        [
          run.runId,
          run.sessionId,
          run.userId,
          run.provider,
          run.model,
          run.contextWindow,
          new Date(run.startedAt),
          run.header === undefined ? null : JSON.stringify(run.header),
          SESSION_RUN_SCHEMA_VERSION,
        ],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`创建 session run 容器失败 (${run.runId})`, cause)
    }
    const row = result.rows[0]
    if (!isRecord(row) || typeof row['run_index'] !== 'number') {
      throw new Error(`创建 session run 容器失败: ${run.runId} 未返回 run_index`)
    }
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      userId: run.userId,
      runIndex: row['run_index'],
      provider: run.provider,
      model: run.model,
      contextWindow: run.contextWindow,
      status: SESSION_RUN_STATUSES.RUNNING,
      startedAt: run.startedAt,
      endedAt: null,
      ...optionalField('header', run.header),
      facts: [],
      schemaVersion: SESSION_RUN_SCHEMA_VERSION,
    }
  }

  public async appendFact(runId: string, fact: RunFact, signal: AbortSignal): Promise<void> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `UPDATE session_runs
         SET facts = facts || $2::jsonb,
             updated_at = now()
         WHERE run_id = $1 AND ended_at IS NULL`,
        [runId, JSON.stringify(fact)],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`追加 session run 事实失败 (${runId})`, cause)
    }
    if (result.rowCount === 0) {
      throw new Error(`session run ${runId} 不存在或已终态，拒绝追加事实`)
    }
  }

  public async finalize(
    runId: string,
    command: FinalizeSessionRunCommand,
    signal: AbortSignal
  ): Promise<void> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `UPDATE session_runs
         SET status = $2,
             ended_at = $3,
             cancelled_at = $4,
             cancelled_by = $5,
             error = $6,
             updated_at = now()
         WHERE run_id = $1 AND ended_at IS NULL`,
        [
          runId,
          command.status,
          new Date(command.endedAt),
          command.cancelledAt === undefined ? null : new Date(command.cancelledAt),
          command.cancelledBy ?? null,
          command.error ?? null,
        ],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`提交 session run 终态失败 (${runId})`, cause)
    }
    if (result.rowCount === 0) {
      throw new Error(`session run ${runId} 不存在或已终态，拒绝重复终态化`)
    }
  }

  public async listBySession(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly SessionRunRecord[]> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `SELECT ${SESSION_RUN_ROW_COLUMNS}
         FROM session_runs
         WHERE session_id = $1
         ORDER BY run_index ASC`,
        [sessionId],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`查询 session run 事实日志失败 (${sessionId})`, cause)
    }
    return result.rows.map((row: unknown): SessionRunRecord => parseSessionRunRecord(row))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contextualError(context: string, cause: unknown): Error {
  return new Error(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, {
    cause,
  })
}
