import { z } from 'zod'

import type { SqlExecutor } from '../../../../infra/database/postgres.js'
import type { User, UserPage } from '../../model/user.js'
import { UserRepositoryConflictError, type UserRepository } from './port/user-repository.port.js'

/**
 * `users` 表单行的形状校验：库列名保持蛇形，与领域实体的驼峰在 `toUser` 处翻译。
 *
 * `avatar` 显式允许 `null`（库中未设置为 NULL，实体里是 `undefined`）；时间列声明为 `date`，
 * 因为驱动已把 `timestamptz` 解析成 `Date`。坏行一律抛错而非静默丢弃，避免错误数据被当成缺省。
 */
const userRowSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  password_hash: z.string(),
  display_name: z.string(),
  avatar: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
})

/**
 * 窗口函数 `COUNT(*) OVER()` 结果的校验：接受数字或纯数字字符串。
 *
 * 两种形态都收，是因为不同驱动/配置下 `bigint` 可能以字符串返回；随后统一 `transform` 成数字，
 * 并 `refine` 到安全整数范围，防止超过 `Number.MAX_SAFE_INTEGER` 的计数被静默截断。
 */
const totalCountSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u).transform(Number)])
  .refine(Number.isSafeInteger, 'total_count must be a safe integer')

/** 用户列表行的形状：在单行 Schema 上追加窗口函数带出的命中总数。 */
const userListRowSchema = userRowSchema.extend({ total_count: totalCountSchema })

/**
 * 所有查询共用的列清单，保持与 `userRowSchema` 的字段一一对应。
 *
 * 抽成常量是为了让 SELECT 与行校验不至于各写各的而漂移；不含 `total_count`，
 * 那是列表查询额外用窗口函数算出的派生列。
 */
const USER_COLUMNS = `
  id,
  username,
  email,
  password_hash,
  display_name,
  avatar,
  is_active,
  created_at,
  updated_at
`

/**
 * Identity Module 的 PostgreSQL 用户仓储，由 `identity.module.ts` 绑定到 `UserRepository`。
 * 数据库唯一约束映射为仓储冲突；事务与连接所有权仍由注入的 SqlExecutor 管理。
 */
export class PostgresUserRepository implements UserRepository {
  /** SQL 执行器，构造时注入；本仓储不持有连接池，事务与连接所有权仍归执行器。 */
  readonly #database: SqlExecutor
  /**
   * 写入 `updated_at` 的时钟，构造时确定；默认取系统时钟，测试可注入固定实现。
   * @returns 当前时刻
   */
  readonly #now: () => Date

  public constructor(database: SqlExecutor, now: () => Date = (): Date => new Date()) {
    this.#database = database
    this.#now = now
  }

  /**
   * 插入新用户。
   *
   * 命中唯一约束（用户名/邮箱冲突）时翻译为 `UserRepositoryConflictError`，供用例层区分为业务
   * 冲突；其余失败包装成带上下文错误。单条 INSERT 原子完成，失败不留下半成品行。
   *
   * @param user - 待写入的领域用户实体；`id` 与时间戳由调用方生成，本方法不再改写
   * @param signal - 取消信号，透传给 SqlExecutor；取消时由执行器负责回滚
   */
  public async create(user: User, signal: AbortSignal): Promise<void> {
    try {
      await this.#database.query(
        `INSERT INTO users (
          id, username, email, password_hash, display_name, avatar,
          is_active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          user.id,
          user.username,
          user.email,
          user.passwordHash,
          user.displayName,
          user.avatar ?? null,
          user.isActive,
          user.createdAt,
          user.updatedAt,
        ],
        signal
      )
    } catch (cause: unknown) {
      if (isPostgresUniqueViolation(cause)) {
        throw new UserRepositoryConflictError('用户唯一键冲突', cause)
      }
      throw contextualError('创建用户失败', cause)
    }
  }

  /**
   * 按主键查用户。
   *
   * 行数据先经 Schema 校验再映射为实体，坏行抛错而非静默丢弃。
   *
   * @param userId - 目标用户 ID
   * @param signal - 取消信号，透传给 SqlExecutor
   * @returns 命中的领域用户实体；不存在时返回 `undefined` 而不是抛错
   */
  public getById(userId: string, signal: AbortSignal): Promise<User | undefined> {
    return this.#findOne('id', userId, `查询用户失败 (id=${userId})`, signal)
  }

  /**
   * 按用户名查用户，用于登录与注册唯一性预检查。
   *
   * @param username - 目标用户名；错误信息只带用户名本身，不含口令
   * @param signal - 取消信号，透传给 SqlExecutor
   * @returns 命中的领域用户实体；不存在时返回 `undefined`
   */
  public getByUsername(username: string, signal: AbortSignal): Promise<User | undefined> {
    return this.#findOne('username', username, `查询用户失败 (username=${username})`, signal)
  }

  /**
   * 按邮箱查用户，用于注册唯一性预检查。
   *
   * @param email - 目标邮箱
   * @param signal - 取消信号，透传给 SqlExecutor
   * @returns 命中的领域用户实体；不存在时返回 `undefined`
   */
  public getByEmail(email: string, signal: AbortSignal): Promise<User | undefined> {
    return this.#findOne('email', email, `查询用户失败 (email=${email})`, signal)
  }

  /**
   * 按主键更新用户的可变字段。
   *
   * SET 列表只含 email/display_name/avatar/is_active，身份字段与 `created_at` 不在其中；
   * `updated_at` 取仓储时钟而非实体字段，避免调用方写入过期时间。目标不存在时静默无操作。
   *
   * @param user - 携带新字段值的用户实体；`id` 决定更新目标
   * @param signal - 取消信号，透传给 SqlExecutor
   */
  public async update(user: User, signal: AbortSignal): Promise<void> {
    try {
      await this.#database.query(
        `UPDATE users
         SET email = $1, display_name = $2, avatar = $3, is_active = $4, updated_at = $5
         WHERE id = $6`,
        [user.email, user.displayName, user.avatar ?? null, user.isActive, this.#now(), user.id],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`更新用户失败 (id=${user.id})`, cause)
    }
  }

  /**
   * 软删除用户：置 `is_active = FALSE` 并刷新 `updated_at`，不物理删行。
   *
   * 保留行是为了让历史外键与审计可追溯；目标不存在时同样静默返回，调用方可按幂等处理。
   *
   * @param userId - 要停用的用户 ID
   * @param signal - 取消信号，透传给 SqlExecutor
   */
  public async delete(userId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#database.query(
        `UPDATE users SET is_active = FALSE, updated_at = $1 WHERE id = $2`,
        [this.#now(), userId],
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`删除用户失败 (id=${userId})`, cause)
    }
  }

  /**
   * 分页查询活跃用户。
   *
   * 只返回 `is_active = TRUE` 的行，用窗口函数一次取回命中总数以免额外的计数查询；行序按
   * `created_at` 倒序，`total` 取自首行，空结果记为 0。
   *
   * @param offset - 起始偏移，由上游解析层归一化
   * @param limit - 每页条数，由上游解析层夹取
   * @param signal - 取消信号，透传给 SqlExecutor
   * @returns 用户分页结果；`users` 只含活跃用户，`total` 是同等条件下的总数
   */
  public async list(offset: number, limit: number, signal: AbortSignal): Promise<UserPage> {
    try {
      const result = await this.#database.query(
        `SELECT ${USER_COLUMNS}, COUNT(*) OVER() AS total_count
         FROM users
         WHERE is_active = TRUE
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
        signal
      )
      const parsed = result.rows.map(parseUserListRow)
      return {
        users: parsed.map(toUser),
        total: parsed[0]?.total_count ?? 0,
      }
    } catch (cause: unknown) {
      throw contextualError('查询用户列表失败', cause)
    }
  }

  /**
   * 按给定列做单值等值查询，取首个命中行并映射为实体，供三个 getByXxx 共用。
   *
   * 列名来自受限的枚举而非外部输入，因此可安全拼接进 SQL，值仍走参数化绑定；行经 Schema 校验，
   * 坏行抛错；查询失败统一包上调用方给定的中文上下文，便于定位是哪个字段的查询出的问题。
   *
   * @param column - 查询所用的列名，只允许 `id` / `username` / `email` 三个
   * @param value - 该列的目标值，走参数化绑定
   * @param errorContext - 查询失败时包裹错误的上下文文案，由调用点按字段语义给出
   * @param signal - 取消信号，透传给 SqlExecutor
   * @returns 命中的领域用户实体；无命中时为 `undefined`
   */
  async #findOne(
    column: 'id' | 'username' | 'email',
    value: string,
    errorContext: string,
    signal: AbortSignal
  ): Promise<User | undefined> {
    try {
      const result = await this.#database.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE ${column} = $1`,
        [value],
        signal
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      const validation = userRowSchema.safeParse(row)
      if (!validation.success) throw new Error('用户行数据非法', { cause: validation.error })
      return toUser(validation.data)
    } catch (cause: unknown) {
      throw contextualError(errorContext, cause)
    }
  }
}

/**
 * 校验单条用户列表行；任一行不符合 schema 即抛错，坏行不会被静默丢弃。
 *
 * 与 `#findOne` 内的行校验取向一致：宁可让整个列表请求失败也不返回缺字段或类型错的值，
 * 否则分页结果里会混入难以察觉的坏数据。
 *
 * @param row - 数据库返回的单行原始值，类型未知
 * @returns 通过 Schema 校验的列表行，字段已按声明类型收窄
 */
function parseUserListRow(row: unknown): z.infer<typeof userListRowSchema> {
  const validation = userListRowSchema.safeParse(row)
  if (!validation.success) {
    throw new Error('用户行数据非法', { cause: validation.error })
  }
  return validation.data
}

/**
 * 判定异常是否为 PostgreSQL 唯一约束冲突（SQLSTATE `23505`）。
 *
 * 驱动把错误码放在 `cause.code` 上而没有可 `instanceof` 的导出类型，因此只按码匹配；
 * 非对象与缺码的情形一律返回 `false`，不误判为冲突。
 *
 * @param cause - 捕获到的未知异常
 * @returns 是唯一约束冲突时为 `true`
 */
function isPostgresUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505'
}

/**
 * 把库行映射为领域用户实体，蛇形列名转驼峰，库中的 `NULL` 头像转成 `undefined`。
 *
 * 纯映射、不做校验（校验已在 `#findOne` / `parseUserListRow` 完成），失败只可能来自字段缺失，
 * 那属于调用方漏传已校验的行。
 *
 * @param row - 已通过 Schema 校验的单行数据
 * @returns 领域用户实体，字段名与可空性已对齐 `User`
 */
function toUser(row: z.infer<typeof userRowSchema>): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    avatar: row.avatar ?? undefined,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 给底层异常包一层中文上下文，并保留原始 cause 以便排查。
 *
 * 非 Error 的抛出值（字符串、对象等）先归一成 Error 再取 message；`cause` 原样挂到新错误上，
 * 堆栈与驱动信息不丢失。这里的 message 只进日志，不会作为响应体外泄。
 *
 * @param context - 描述本次操作的中文前缀，如「创建用户失败 (id=...)」
 * @param cause - 被包裹的原始异常，类型未知
 * @returns 带上下文与 cause 的新错误
 */
function contextualError(context: string, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  return new Error(`${context}：${error.message}`, { cause })
}
