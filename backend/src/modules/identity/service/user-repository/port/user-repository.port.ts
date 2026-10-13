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
  /**
   * 插入新用户。
   *
   * 唯一键冲突（用户名或邮箱）必须转换为 `UserRepositoryConflictError`；单条写入应原子完成，
   * 失败不留下半成品行。
   *
   * @param user - 待写入的领域用户实体，`id` 与时间戳由调用方预先填好
   * @param signal - 请求生命周期绑定的取消信号，取消时由实现负责回滚
   */
  create(user: User, signal: AbortSignal): Promise<void>
  /**
   * 按主键查用户。
   *
   * 不存在是正常分支，返回 `undefined` 而非抛错，由用例层决定是否转成 NOT_FOUND。
   *
   * @param userId - 目标用户 ID
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 命中的领域用户实体；不存在时为 `undefined`
   */
  getById(userId: string, signal: AbortSignal): Promise<User | undefined>
  /**
   * 按用户名查用户，用于登录与注册唯一性预检查。
   *
   * @param username - 目标用户名
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 命中的领域用户实体；不存在时为 `undefined`
   */
  getByUsername(username: string, signal: AbortSignal): Promise<User | undefined>
  /**
   * 按邮箱查用户，用于注册唯一性预检查。
   *
   * @param email - 目标邮箱
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 命中的领域用户实体；不存在时为 `undefined`
   */
  getByEmail(email: string, signal: AbortSignal): Promise<User | undefined>
  /**
   * 按主键更新用户。
   *
   * 只写入可变字段（邮箱、展示名、头像、启用状态等），身份字段与创建时间不可改；目标不存在时
   * 按幂等处理，静默无操作。
   *
   * @param user - 携带新字段值的用户实体，`id` 决定更新目标
   * @param signal - 请求生命周期绑定的取消信号
   */
  update(user: User, signal: AbortSignal): Promise<void>
  /**
   * 删除用户。
   *
   * 是否软删除由实现决定；无论哪种，目标不存在都应按幂等处理而非抛错。
   *
   * @param userId - 要删除的用户 ID
   * @param signal - 请求生命周期绑定的取消信号
   */
  delete(userId: string, signal: AbortSignal): Promise<void>
  /**
   * 分页查询用户。
   *
   * 分页参数由调用方归一化；无匹配时返回空列表，不抛错。`total` 是符合查询条件的总数，
   * 与当页返回的 `users` 长度无关。
   *
   * @param offset - 起始偏移，非负整数
   * @param limit - 每页条数
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 用户分页结果，含当前页记录与命中总数
   */
  list(offset: number, limit: number, signal: AbortSignal): Promise<UserPage>
}
