import { z } from 'zod'

import type { SqlExecutor } from '../../../../infra/database/postgres.js'
import type { User, UserPage } from '../../model/user.js'
import { UserRepositoryConflictError, type UserRepository } from './port/user-repository.port.js'

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

const totalCountSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u).transform(Number)])
  .refine(Number.isSafeInteger, 'total_count must be a safe integer')

const userListRowSchema = userRowSchema.extend({ total_count: totalCountSchema })

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
  readonly #database: SqlExecutor
  readonly #now: () => Date

  public constructor(database: SqlExecutor, now: () => Date = (): Date => new Date()) {
    this.#database = database
    this.#now = now
  }

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

  public getById(userId: string, signal: AbortSignal): Promise<User | undefined> {
    return this.#findOne('id', userId, `查询用户失败 (id=${userId})`, signal)
  }

  public getByUsername(username: string, signal: AbortSignal): Promise<User | undefined> {
    return this.#findOne('username', username, `查询用户失败 (username=${username})`, signal)
  }

  public getByEmail(email: string, signal: AbortSignal): Promise<User | undefined> {
    return this.#findOne('email', email, `查询用户失败 (email=${email})`, signal)
  }

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
      const parsed = result.rows.map((row: unknown): z.infer<typeof userListRowSchema> => {
        const validation = userListRowSchema.safeParse(row)
        if (!validation.success) {
          throw new Error('invalid users row', { cause: validation.error })
        }
        return validation.data
      })
      return {
        users: parsed.map(toUser),
        total: parsed[0]?.total_count ?? 0,
      }
    } catch (cause: unknown) {
      throw contextualError('查询用户列表失败', cause)
    }
  }

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
      if (!validation.success) throw new Error('invalid users row', { cause: validation.error })
      return toUser(validation.data)
    } catch (cause: unknown) {
      throw contextualError(errorContext, cause)
    }
  }
}

function isPostgresUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505'
}

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

function contextualError(context: string, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  return new Error(`${context}: ${error.message}`, { cause })
}
