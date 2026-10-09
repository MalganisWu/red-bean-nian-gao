import type { User, UserPage } from '../../../model/user.js'

/** 用户唯一约束冲突；隔离具体数据库错误码，供应用层稳定识别并发写入竞争。 */
export class UserRepositoryConflictError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'UserRepositoryConflictError'
  }
}

/**
 * Identity Module 的用户持久化边界。
 * 默认实现为 `PostgresUserRepository`，由 `identity.module.ts` 创建；数据库唯一约束冲突必须转换为
 * `UserRepositoryConflictError`，Application Service 负责把它映射为稳定业务结果。
 */
export interface UserRepository {
  create(user: User, signal: AbortSignal): Promise<void>
  getById(userId: string, signal: AbortSignal): Promise<User | undefined>
  getByUsername(username: string, signal: AbortSignal): Promise<User | undefined>
  getByEmail(email: string, signal: AbortSignal): Promise<User | undefined>
  update(user: User, signal: AbortSignal): Promise<void>
  delete(userId: string, signal: AbortSignal): Promise<void>
  list(offset: number, limit: number, signal: AbortSignal): Promise<UserPage>
}
