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
  /** 登录名；唯一性由用例预检查与数据库约束双重保证。 */
  readonly username: string
  /** 邮箱；同样要求全局唯一，冲突一律收敛为 CONFLICT 用例错误。 */
  readonly email: string
  /** 明文密码；仅在本用例内交给散列器，不落库、不进日志。 */
  readonly password: string
  /** 展示名；注册时必填，无默认推导。 */
  readonly displayName: string
  /** 初始头像地址；未提供时不写入该字段，交由聚合保持缺省。 */
  readonly avatar?: string | undefined
}

/** 服务依赖；除用户仓储外还需要散列器与 ID 生成器，三者都可替换以适配测试。 */
export interface IdentityRegistrationServiceOptions {
  /** 用户仓储；唯一性查询与落库都经它。 */
  readonly users: UserRepository
  /** 密码散列器；生产为 bcrypt，测试可注入轻量实现以避开计算开销。 */
  readonly passwordHasher: PasswordHasher
  /** 用户 ID 生成器；注入而非本地自造，保证 ID 策略全局一致。 */
  readonly idGenerator: IdGenerator
  /**
   * 产生创建/更新时间戳的时钟；缺省用系统时钟，测试注入固定值以获得确定性。
   * @returns 当前时刻
   */
  readonly now?: (() => Date) | undefined
}

/**
 * 用户注册用例，内部 1:1 实现，无独立 Port；由 `identity.module.ts` 组装，
 * Controller 直接依赖本类。注册流程可在 register 方法内一次读完。
 */
export class IdentityRegistrationService {
  /** 用户仓储，构造时注入，唯一性查询与落库都透传取消信号。 */
  readonly #users: UserRepository
  /** 密码散列器，构造时注入；注册全程只在这里使用一次。 */
  readonly #passwordHasher: PasswordHasher
  /** 用户 ID 生成器，构造时注入；只用于生成新用户的 id。 */
  readonly #idGenerator: IdGenerator
  /**
   * 产生创建/更新时间戳的时钟，构造时确定；默认取系统时钟，测试可注入固定实现。
   * @returns 当前时刻
   */
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

  /**
   * 用户名与邮箱任一已存在即拒绝；返回时保证两者都可用。
   *
   * 两步查询都带取消信号，客户端断开时尽快放弃；并发窗口由数据库唯一约束兜底，
   * 因此这里的检查只优化错误文案，不承担正确性。
   *
   * @param command - 注册命令；只读取其中的 `username` 与 `email` 做唯一性查询
   * @param signal - 请求生命周期绑定的取消信号，透传给两次仓储查询
   */
  async #assertUnique(command: RegisterIdentityCommand, signal: AbortSignal): Promise<void> {
    if (await this.#users.getByUsername(command.username, signal)) {
      throw new IdentityApplicationError(IDENTITY_APPLICATION_ERROR_CODES.CONFLICT, '用户名已存在')
    }
    if (await this.#users.getByEmail(command.email, signal)) {
      throw new IdentityApplicationError(IDENTITY_APPLICATION_ERROR_CODES.CONFLICT, '邮箱已存在')
    }
  }

  /**
   * 组装初始用户状态：散列密码、生成 ID、设置时间戳与默认活跃状态。
   *
   * 纯函数式的对象拼装，不触碰仓储；创建时间与更新时间取同一时刻，避免刚创建即出现
   * 「更新早于创建」的差异。新用户一律置为活跃，停用走后续的资料更新路径。
   *
   * @param command - 注册命令；提供身份字段与展示名，密码字段已不在此使用
   * @param passwordHash - 已散列的密码；由调用方先散列后传入，本方法不再接触明文
   * @returns 可直接交给仓储落库的领域用户实体
   */
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
