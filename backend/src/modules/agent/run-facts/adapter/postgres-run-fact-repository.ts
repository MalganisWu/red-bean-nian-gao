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
  /** PostgreSQL SQL 执行器；会话事实日志的读写都经它落到 session_runs 表。 */
  readonly #database: SqlExecutor

  public constructor(database: SqlExecutor) {
    this.#database = database
  }

  /**
   * 建立 run 容器并落库；run_index 在同一条 INSERT..SELECT 内按会话分配，
   * 依赖调用方已持有 session 锁串行化同一会话的 run，避免并发撞号。
   * 未拿到 run_index（行形状异常）即抛错，调用方据此认定容器未建立。
   *
   * @param run - 本次运行的容器命令；runId 由调用方生成，用于错误定位
   * @param signal - 传给 SQL 执行器的中止信号；中止即放弃创建，不留半条记录
   * @returns 落库后的容器记录，run_index 由数据库分配
   */
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

  /**
   * 以 `ended_at IS NULL` 为 SQL 守卫追加一条事实，保证 append-only：
   * run 已终态时拒绝写入，避免给已关闭的容器继续挂事实。
   *
   * @param runId - 目标 run 容器；不存在或已终态时抛错
   * @param fact - 一条带 schemaVersion 的事实，序列化后并入 JSONB
   * @param signal - SQL 中止信号；中止即放弃本次追加
   */
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

  /**
   * 提交 run 终态（status / ended_at / 取消归属 / error），同样以 `ended_at IS NULL` 守卫。
   * 重复终态化会抛错而不是覆盖首个终态——首个终态才是这次运行的真实归属。
   *
   * @param runId - 目标 run 容器；不存在或已终态时抛错
   * @param command - 终态命令；取消归属与结束时刻由调用方给出
   * @param signal - SQL 中止信号
   */
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

  /**
   * 按 run_index 升序读取会话的全部 run 容器及其事实序列；行经信任边界校验后映射。
   *
   * @param sessionId - 会话 ID；无记录时返回空数组而非 undefined
   * @param signal - SQL 中止信号
   * @returns 会话内的 run 记录，按 run_index 升序
   */
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

/**
 * 判定数据库返回值是否为非数组对象；在校验列形状前先排除数组与 null。
 * @param value 待判定的未知值
 * @returns 是非数组对象时为 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 给仓储错误套上中文上下文并保留 cause 链：日志里既能看到是哪次操作失败，又不断掉底层根因。
 * @param context 中文上下文（含关键 ID），用于定位是哪次 run / 会话操作失败
 * @param cause 捕获到的原始错误；作为 cause 保留以不断链
 * @returns 带上下文消息与 cause 链的新错误
 */
function contextualError(context: string, cause: unknown): Error {
  return new Error(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, {
    cause,
  })
}
