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

/**
 * 查询会话时统一选出的列清单；`parseSession` 与 `parseSessionSummary` 共用同一份 Schema。
 * 抽成常量是为了让所有查询选同一组列，避免某处漏列导致解析在运行时才失败。
 */
const SESSION_COLUMNS = `
  session_id,
  user_id,
  runtime_state,
  display_messages,
  revision,
  fencing_token,
  updated_at
`

/**
 * 面向现有 sessions 表并实现 CAS/fencing 契约的 PostgreSQL adapter。
 *
 * 三条贯穿全文件的约定：
 * - **所有查询都带 `user_id`**：越权与不存在返回同一个 `NOT_FOUND`，
 *   调用方无法靠错误码探出「这个 session 存在，只是不属于我」。
 * - **CAS 与 fencing 写进同一条 UPDATE 的 WHERE**：`revision = $3 AND fencing_token = $4`。
 *   分成两步检查就会有窗口，而这里靠数据库的原子性一次判定。
 * - **每次失败的写入都要给出可区分的错误**：见 `#throwSaveConflict`。
 */
export class PostgresSessionRepository implements FencedSessionRepository {
  /** 注入的 SQL 执行器；全部读写都经它下发，取消信号一并透传。 */
  readonly #database: SqlExecutor
  public constructor(database: SqlExecutor) {
    this.#database = database
  }

  /**
   * 取得会话，不存在则创建。
   *
   * `ON CONFLICT DO NOTHING` 处理的是并发创建：两个实例同时发现会话不存在并同时 INSERT，
   * 只有一个会成功，另一个 `rowCount === 0`。此时**必须重新读一次**而不是直接返回自己构造的空会话——
   * 否则会拿着一个 revision 0 的假状态去写，把对方的创建覆盖掉。
   *
   * 另一个分支：会话已存在但不属于这个 userId 时抛 `NOT_FOUND` 而不是「已存在」，
   * 避免把别人的会话 ID 变成可探测的信息。
   *
   * @param sessionId - 目标会话标识；不存在时以它作为新行主键。
   * @param userId - 会话归属用户，写入新行并参与越权判定。
   * @param signal - 取消信号，透传到每条 SQL，取消时中止而非留下半截状态。
   * @returns 会话聚合；新建时 revision 与 fencing_token 均为 0。
   */
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

  /**
   * 按标识读取会话，不创建。
   *
   * 查询强制带 `user_id` 条件，越权与不存在收敛到同一条 `NOT_FOUND`。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 归属校验依据；不匹配即视为不存在。
   * @param signal - 取消信号，透传到 SQL。
   * @returns 会话聚合。
   */
  public async getById(sessionId: string, userId: string, signal: AbortSignal): Promise<Session> {
    const session = await this.#findOwned(sessionId, userId, signal)
    if (session === undefined) throw sessionNotFound()
    return session
  }

  /**
   * CAS 保存。`RETURNING revision` 让成功路径不必再查一次就能把新版本写回调用方持有的对象。
   * 写入 0 行时交给 `#throwSaveConflict` 判定到底是哪一种冲突——区分它们对调用方很重要：
   * 版本冲突可以重读后重试，fencing 陈旧则说明锁已被别人接管，重试没有意义。
   *
   * @param session - 待保存的会话快照；其 `revision` 与 `fencingToken` 进 WHERE 做 CAS，成功后就地更新 `revision`。
   * @param signal - 取消信号，透传到 SQL。
   */
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

  /**
   * 键集分页（keyset pagination），游标是上一页最后一条的 `updated_at`。
   *
   * `ORDER BY updated_at DESC, session_id DESC` 里的第二个字段不能省：
   * 同一毫秒内更新的多条会话仅按时间排序，顺序在两次查询之间可能不同，
   * 翻页就会漏掉或重复记录。加上唯一列做兜底排序才能得到稳定顺序。
   *
   * @param userId - 只返回属于该用户的会话。
   * @param cursor - 上一页末条的 `updated_at` ISO 串；空串表示首页，非法时间戳直接抛错而不再兜底成首页。
   * @param limit - 页大小；非正数按 20 兜底。
   * @param signal - 取消信号，透传到 SQL。
   * @returns 摘要列表；不含 runtimeState 与完整消息列表。
   */
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

  /**
   * 把会话的 fencing 高水位推到 `token`。
   *
   * `fencing_token <= $1` 让「不倒退」由 SQL 保证，无需先读后写：
   * 传一个更小的 token 匹配不到任何行，于是走下面的失败分支报 `STALE_FENCE`。
   * `token === 0n` 直接返回：0 的语义是「未启用 fencing」，不该被当成一次推进。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 归属校验依据；不匹配即视为不存在。
   * @param token - 新的围栏序号；`0n` 表示无操作，更小的值会被 SQL 判为不匹配而报 `STALE_FENCE`。
   * @param signal - 取消信号，透传到 SQL。
   */
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

  /**
   * 取下一个围栏序号。
   *
   * 值来自数据库序列 `session_fencing_token_seq`，跨实例全局单调，
   * 这是 Redis 侧兜底 token 源做不到的——多实例部署时必须注入本实现。
   *
   * @param signal - 取消信号，透传到 SQL。
   * @returns 新分配的围栏序号。
   */
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

  /**
   * 按会话与归属读取聚合并解析；查询强制带 `user_id`，越权与不存在等价。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 归属校验依据；不匹配即视为查不到。
   * @param signal - 取消信号，透传到 SQL。
   * @returns 解析出的会话聚合；不存在或不属于该用户时返回 undefined。
   */
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

  /**
   * 只取归属与版本列，不读全量聚合；用于冲突判定与所有权校验的轻量路径。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 取消信号，透传到 SQL。
   * @returns 所有权投影行；行不存在时返回 undefined。
   */
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

  /**
   * UPDATE 写入 0 行时判定冲突类型，按**从「更根本」到「更琐碎」**的顺序排查：
   * 1. 行不存在或不属于本用户 → `NOT_FOUND`（连能不能写都不成立）。
   * 2. `fencing_token` 与传入不符 → `STALE_FENCE`（锁已被接管，调用方应当放弃而不是重试）。
   * 3. 其余情况 → `REVISION_CONFLICT`（并发写，重读最新版本后可以重试）。
   *
   * 顺序不能调换：fencing 陈旧时若先报版本冲突，调用方会去重试一个它已经无权执行的操作。
   *
   * @param session - 刚才尝试保存的快照，用其 id 与 userId 重新核对所有者。
   * @param signal - 取消信号，透传到归属查询。
   */
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

/**
 * 构造新会话的初始聚合：空消息列表，revision 与 fencing_token 均为 0。
 * 只在确认 INSERT 成功（rowCount > 0）后使用，避免拿着假状态去覆盖别人的并发创建。
 *
 * @param sessionId - 新会话标识。
 * @param userId - 会话归属用户。
 * @returns 刚建出的空会话。
 */
function emptySession(sessionId: string, userId: string): Session {
  return {
    id: sessionId,
    userId,
    displayMessages: [],
    revision: 0n,
    fencingToken: 0n,
  }
}

/**
 * 把列表游标解析成时间。空串表示首页，返回 undefined 让调用方省掉 `updated_at <` 条件；
 * 非空但不是合法时间戳时直接抛错，不静默兜底成首页——那会让翻页悄悄从头再来。
 *
 * @param cursor - 上一页末条的 `updated_at` ISO 串，或空串。
 * @returns 首页时为 undefined，否则为解析出的时间点。
 */
function parseCursor(cursor: string): Date | undefined {
  if (cursor === '') return undefined
  const timestamp = Date.parse(cursor)
  if (!Number.isFinite(timestamp)) throw new Error('invalid cursor')
  return new Date(timestamp)
}

/**
 * 构造会话不存在的领域错误；越权与真的不存在共用它，避免暴露会话归属。
 *
 * @returns `NOT_FOUND` 类型的 SessionStoreError。
 */
function sessionNotFound(): SessionStoreError {
  return new SessionStoreError(SESSION_STORE_ERROR_CODES.NOT_FOUND, 'session not found')
}

/**
 * 给底层失败补上中文上下文再抛出，并保留 cause 链——
 * 只取 message 重抛会让日志与观测断链，原始错误必须留在 cause 里。
 *
 * @param context - 中文上下文前缀，说明这次操作在做什么。
 * @param cause - 被包装的原始错误，可能是任意抛出物。
 * @returns 带上下文与 cause 的错误。
 */
function contextualError(context: string, cause: unknown): Error {
  return new Error(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, {
    cause,
  })
}
