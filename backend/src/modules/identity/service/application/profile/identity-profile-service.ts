import type { User, UserPage } from '../../../model/user.js'
import type { UserRepository } from '../../user-repository/port/user-repository.port.js'
import {
  IDENTITY_APPLICATION_ERROR_CODES,
  IdentityApplicationError,
} from '../error/identity-application-error.js'

/** 更新自己资料的命令；只有显式出现的字段会被写入，缺省即保持原值。 */
export interface UpdateSelfCommand {
  readonly userId: string
  readonly displayName?: string | undefined
  readonly avatar?: string | undefined
  readonly email?: string | undefined
}

/** 服务依赖；`now` 可注入，测试因此不依赖真实时钟。 */
export interface IdentityProfileServiceOptions {
  readonly users: UserRepository
  readonly now?: (() => Date) | undefined
}

/**
 * 用户资料查询与维护用例，内部 1:1 实现，无独立 Port；由 `identity.module.ts` 组装，
 * Controller 直接依赖本类。查询与更新流程可在各公开方法内一次读完。
 */
export class IdentityProfileService {
  readonly #users: UserRepository
  readonly #now: () => Date

  public constructor(options: IdentityProfileServiceOptions) {
    this.#users = options.users
    this.#now = options.now ?? ((): Date => new Date())
  }

  public getSelf(userId: string, signal: AbortSignal): Promise<User> {
    return this.#requireUser(userId, signal)
  }

  /** 只更新命令中显式出现的字段，其余保持原值，并刷新 updatedAt。 */
  public async updateSelf(command: UpdateSelfCommand, signal: AbortSignal): Promise<User> {
    const user = await this.#requireUser(command.userId, signal)
    if (command.displayName !== undefined) user.displayName = command.displayName
    if (command.avatar !== undefined) user.avatar = command.avatar
    if (command.email !== undefined) user.email = command.email
    user.updatedAt = this.#now()
    await this.#users.update(user, signal)
    return user
  }

  public getPublicUser(userId: string, signal: AbortSignal): Promise<User> {
    return this.#requireUser(userId, signal)
  }

  public listUsers(offset: number, limit: number, signal: AbortSignal): Promise<UserPage> {
    return this.#users.list(offset, limit, signal)
  }

  /** 用户不存在时抛出稳定 NOT_FOUND 错误，Controller 据此映射 HTTP 404。 */
  async #requireUser(userId: string, signal: AbortSignal): Promise<User> {
    const user = await this.#users.getById(userId, signal)
    if (user === undefined) {
      throw new IdentityApplicationError(IDENTITY_APPLICATION_ERROR_CODES.NOT_FOUND, '用户不存在')
    }
    return user
  }
}
