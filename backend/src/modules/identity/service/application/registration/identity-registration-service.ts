import type { IdGenerator } from '../../../../../shared/id/id-generator.js'
import type { PasswordHasher } from '../../authentication/port/password-hasher.port.js'
import type { User } from '../../../model/user.js'
import {
  UserRepositoryConflictError,
  type UserRepository,
} from '../../user-repository/port/user-repository.port.js'
import {
  IDENTITY_APPLICATION_ERROR_CODES,
  IdentityApplicationError,
} from '../error/identity-application-error.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

/** 注册命令；密码在这里仍是明文，散列由本用例完成，调用方拿不到也不该管这个过程。 */
export interface RegisterIdentityCommand {
  readonly username: string
  readonly email: string
  readonly password: string
  readonly displayName: string
  readonly avatar?: string | undefined
}

/** 服务依赖；除用户仓储外还需要散列器与 ID 生成器，三者都可替换以适配测试。 */
export interface IdentityRegistrationServiceOptions {
  readonly users: UserRepository
  readonly passwordHasher: PasswordHasher
  readonly idGenerator: IdGenerator
  readonly now?: (() => Date) | undefined
}

/**
 * 用户注册用例，内部 1:1 实现，无独立 Port；由 `identity.module.ts` 组装，
 * Controller 直接依赖本类。注册流程可在 register 方法内一次读完。
 */
export class IdentityRegistrationService {
  readonly #users: UserRepository
  readonly #passwordHasher: PasswordHasher
  readonly #idGenerator: IdGenerator
  readonly #now: () => Date

  public constructor(options: IdentityRegistrationServiceOptions) {
    this.#users = options.users
    this.#passwordHasher = options.passwordHasher
    this.#idGenerator = options.idGenerator
    this.#now = options.now ?? ((): Date => new Date())
  }

  /**
   * 注册新用户：先做唯一性预检查，再散列密码并写库。
   *
   * 预检查只优化常见失败文案，数据库唯一约束才是并发注册的最终边界；撞约束时翻译为
   * CONFLICT 用例错误，调用方据此回 409。
   *
   * @param command - 注册命令；`password` 仍为明文，仅在本方法内交给散列器，不落库也不外泄
   * @param signal - 请求生命周期绑定的取消信号，透传给仓储与散列过程
   * @returns 组装完成的领域用户实体，`passwordHash` 已是散列值
   */
  public async register(command: RegisterIdentityCommand, signal: AbortSignal): Promise<User> {
    // 预检查只优化常见失败文案；数据库唯一约束才是并发注册的最终一致性边界。
    await this.#assertUnique(command, signal)

    const user = this.#composeUser(command, await this.#passwordHasher.hash(command.password))
    try {
      await this.#users.create(user, signal)
    } catch (cause: unknown) {
      // 并发注册撞上数据库唯一约束时，统一翻译为业务冲突错误。
      if (cause instanceof UserRepositoryConflictError) {
        throw new IdentityApplicationError(
          IDENTITY_APPLICATION_ERROR_CODES.CONFLICT,
          '用户名或邮箱已存在',
          cause
        )
      }
      throw cause
    }
    return user
  }

  /** 用户名与邮箱任一已存在即拒绝；返回时保证两者都可用。 */
  async #assertUnique(command: RegisterIdentityCommand, signal: AbortSignal): Promise<void> {
    if (await this.#users.getByUsername(command.username, signal)) {
      throw new IdentityApplicationError(IDENTITY_APPLICATION_ERROR_CODES.CONFLICT, '用户名已存在')
    }
    if (await this.#users.getByEmail(command.email, signal)) {
      throw new IdentityApplicationError(IDENTITY_APPLICATION_ERROR_CODES.CONFLICT, '邮箱已存在')
    }
  }

  /** 组装初始用户状态：散列密码、生成 ID、设置时间戳与默认活跃状态。 */
  #composeUser(command: RegisterIdentityCommand, passwordHash: string): User {
    const timestamp = this.#now()
    return {
      id: this.#idGenerator.generate('user'),
      username: command.username,
      email: command.email,
      passwordHash,
      displayName: command.displayName,
      ...optionalField('avatar', command.avatar),
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }
}
