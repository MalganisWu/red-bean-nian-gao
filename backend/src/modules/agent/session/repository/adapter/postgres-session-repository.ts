import type { SqlExecutor } from '../../../../../infra/database/postgres.js'
import { serializeDisplayMessage } from '../../../presentation/presenter/display-message-presenter.js'
import {
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
  type Session,
  type SessionSummary,
} from '../../model/session.js'
import type { FencedSessionRepository } from '../port/session-repository.port.js'
import {
  parseFencingToken,
  parseRevision,
  parseSession,
  parseSessionOwner,
  parseSessionSummary,
  toBigInt,
  type SessionOwnerRow,
} from '../persistence/session-row-mapper.js'

const SESSION_COLUMNS = `
  session_id,
  user_id,
  runtime_state,
  display_messages,
  revision,
  fencing_token,
  updated_at
`

/** 面向现有 sessions 表并实现 CAS/fencing 契约的 PostgreSQL adapter。 */
export class PostgresSessionRepository implements FencedSessionRepository {
  readonly #database: SqlExecutor
  public constructor(database: SqlExecutor) {
    this.#database = database
  }

  public async getOrCreate(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<Session> {
    const existing = await this.#findOwned(sessionId, userId, signal)
    if (existing !== undefined) return existing
    const owner = await this.#owner(sessionId, signal)
    if (owner !== undefined) throw sessionNotFound()
    try {
      const inserted = await this.#database.query(
        `INSERT INTO sessions (
          session_id, user_id, runtime_state, display_messages, revision, fencing_token
        ) VALUES ($1, $2, NULL, '[]'::jsonb, 0, 0)
        ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, userId],
        signal
      )
      if (inserted.rowCount === 0) {
        const concurrent = await this.#findOwned(sessionId, userId, signal)
        if (concurrent === undefined) throw sessionNotFound()
        return concurrent
      }
      return emptySession(sessionId, userId)
    } catch (cause: unknown) {
      if (cause instanceof SessionStoreError) throw cause
      throw contextualError(`创建 session ${sessionId} 失败`, cause)
    }
  }

  public async getById(sessionId: string, userId: string, signal: AbortSignal): Promise<Session> {
    const session = await this.#findOwned(sessionId, userId, signal)
    if (session === undefined) throw sessionNotFound()
    return session
  }

  public async save(session: Session, signal: AbortSignal): Promise<void> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `UPDATE sessions
         SET runtime_state = $1::jsonb,
             display_messages = $2::jsonb,
             revision = revision + 1,
             updated_at = now()
         WHERE revision = $3 AND fencing_token = $4 AND session_id = $5 AND user_id = $6
         RETURNING revision`,
        [
          session.runtimeState === undefined ? null : JSON.stringify(session.runtimeState),
          JSON.stringify(session.displayMessages.map(serializeDisplayMessage)),
          session.revision,
          session.fencingToken,
          session.id,
          session.userId,
        ],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`保存 session ${session.id} 失败`, cause)
    }
    if (result.rowCount > 0) {
      session.revision = parseRevision(result.rows[0])
      return
    }
    await this.#throwSaveConflict(session, signal)
  }

  public async listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly SessionSummary[]> {
    const effectiveLimit = limit <= 0 ? 20 : limit
    const cursorDate = parseCursor(cursor)
    const parameters: readonly unknown[] =
      cursorDate === undefined ? [userId, effectiveLimit] : [userId, cursorDate, effectiveLimit]
    const cursorClause = cursorDate === undefined ? '' : 'AND updated_at < $2'
    const limitParameter = cursorDate === undefined ? '$2' : '$3'
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions
         WHERE user_id = $1 ${cursorClause}
         ORDER BY updated_at DESC, session_id DESC
         LIMIT ${limitParameter}`,
        parameters,
        signal
      )
    } catch (cause: unknown) {
      throw contextualError('查询会话列表失败', cause)
    }
    return result.rows.map((row: unknown): SessionSummary => parseSessionSummary(row))
  }

  public async advanceFence(
    sessionId: string,
    userId: string,
    token: bigint,
    signal: AbortSignal
  ): Promise<void> {
    if (token === 0n) return
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `UPDATE sessions
         SET fencing_token = $1
         WHERE session_id = $2 AND user_id = $3 AND fencing_token <= $1`,
        [token, sessionId, userId],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`推进 session ${sessionId} fencing token 失败`, cause)
    }
    if (result.rowCount > 0) return
    const owner = await this.#owner(sessionId, signal)
    if (owner === undefined || owner.user_id !== userId) throw sessionNotFound()
    throw new SessionStoreError(SESSION_STORE_ERROR_CODES.STALE_FENCE, 'stale fencing token')
  }

  public async nextFencingToken(signal: AbortSignal): Promise<bigint> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `SELECT nextval('session_fencing_token_seq') AS token`,
        [],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError('生成 session fencing token 失败', cause)
    }
    return parseFencingToken(result.rows[0])
  }

  async #findOwned(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<Session | undefined> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions
         WHERE session_id = $1 AND user_id = $2`,
        [sessionId, userId],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`查询 session ${sessionId} 失败`, cause)
    }
    if (result.rows.length === 0) return undefined
    return parseSession(result.rows[0])
  }

  async #owner(sessionId: string, signal: AbortSignal): Promise<SessionOwnerRow | undefined> {
    let result: Awaited<ReturnType<SqlExecutor['query']>>
    try {
      result = await this.#database.query(
        `SELECT user_id, revision, fencing_token FROM sessions WHERE session_id = $1`,
        [sessionId],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`查询 session ${sessionId} 所有者失败`, cause)
    }
    if (result.rows.length === 0) return undefined
    return parseSessionOwner(result.rows[0])
  }

  async #throwSaveConflict(session: Session, signal: AbortSignal): Promise<never> {
    const current = await this.#owner(session.id, signal)
    if (current === undefined || current.user_id !== session.userId) throw sessionNotFound()
    const fencingToken = toBigInt(current.fencing_token ?? 0, 'fencing token')
    if (fencingToken !== session.fencingToken) {
      throw new SessionStoreError(SESSION_STORE_ERROR_CODES.STALE_FENCE, 'stale fencing token')
    }
    throw new SessionStoreError(
      SESSION_STORE_ERROR_CODES.REVISION_CONFLICT,
      'session revision conflict'
    )
  }
}

function emptySession(sessionId: string, userId: string): Session {
  return {
    id: sessionId,
    userId,
    displayMessages: [],
    revision: 0n,
    fencingToken: 0n,
  }
}

function parseCursor(cursor: string): Date | undefined {
  if (cursor === '') return undefined
  const timestamp = Date.parse(cursor)
  if (!Number.isFinite(timestamp)) throw new Error('invalid cursor')
  return new Date(timestamp)
}

function sessionNotFound(): SessionStoreError {
  return new SessionStoreError(SESSION_STORE_ERROR_CODES.NOT_FOUND, 'session not found')
}

function contextualError(context: string, cause: unknown): Error {
  return new Error(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, {
    cause,
  })
}
