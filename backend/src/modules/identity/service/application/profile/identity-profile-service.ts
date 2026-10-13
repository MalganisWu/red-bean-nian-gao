import type { User, UserPage } from '../../../model/user.js'
import type { UserRepository } from '../../user-repository/port/user-repository.port.js'
import {
  IDENTITY_APPLICATION_ERROR_CODES,
  IdentityApplicationError,
} from '../error/identity-application-error.js'

/** 更新自己资料的命令；只有显式出现的字段会被写入，缺省即保持原值。 */
export interface UpdateSelfCommand {
  /** 写入目标用户 ID；只应来自鉴权后的 Principal，不接受请求体改写。 */
  readonly userId: string
  /** 新展示名；缺省表示不改，与显式传入空串语义不同。 */
  readonly displayName?: string | undefined
  /** 新头像地址；缺省表示不改，传入即整体覆盖原值。 */
  readonly avatar?: string | undefined
  /** 新邮箱；缺省表示不改，传入时由仓储层面承担唯一性约束。 */
  readonly email?: string | undefined
}

/** 服务依赖；`now` 可注入，测试因此不依赖真实时钟。 */
export interface IdentityProfileServiceOptions {
  /** 用户仓储；读写都经它，本服务不持有连接池。 */
  readonly users: UserRepository
  /** 产生 `updatedAt` 的时钟；缺省用系统时钟，测试注入固定值以获得确定性。 */
  readonly now?: (() => Date) | undefined
}

/**
 * 用户资料查询与维护用例，内部 1:1 实现，无独立 Port；由 `identity.module.ts` 组装，
 * Controller 直接依赖本类。查询与更新流程可在各公开方法内一次读完。
 */
export class IdentityProfileService {
  /** 用户仓储，构造时注入，读写都经它并透传取消信号。 */
  readonly #users: UserRepository
  /** 产生时间戳的时钟，构造时确定；默认取系统时钟，测试可注入固定实现。 */
  readonly #now: () => Date

  public constructor(options: IdentityProfileServiceOptions) {
    this.#users = options.users
    this.#now = options.now ?? ((): Date => new Date())
  }

  /**
   * 读取指定用户，供「看自己」视图使用。
   *
   * 用户不存在时抛稳定的 NOT_FOUND 用例错误，由 Controller 映射 404；本方法不校验归属，
   * 调用方必须保证 userId 来自 Principal 而非请求参数。
   *
   * @param userId - 要读取的用户 ID；读取目标，不做越权判断
   * @param signal - 请求生命周期绑定的取消信号，透传给仓储查询
   * @returns 领域用户实体；不含视图裁剪，投影由 presenter 负责
   */
  public getSelf(userId: string, signal: AbortSignal): Promise<User> {
    return this.#requireUser(userId, signal)
  }

  /**
   * 只更新命令中显式出现的字段，其余保持原值，并刷新 updatedAt。
   *
   * @param command - 更新命令；`userId` 决定写入目标，未出现的可选字段一律不覆盖（不会置空）
   * @param signal - 请求生命周期绑定的取消信号，透传给仓储读写
   * @returns 更新后的领域用户实体，`updatedAt` 已是本次写入时间
   */
  public async updateSelf(command: UpdateSelfCommand, signal: AbortSignal): Promise<User> {
    const user = await this.#requireUser(command.userId, signal)
    if (command.displayName !== undefined) user.displayName = command.displayName
    if (command.avatar !== undefined) user.avatar = command.avatar
    if (command.email !== undefined) user.email = command.email
    user.updatedAt = this.#now()
    await this.#users.update(user, signal)
    return user
  }

  /**
   * 读取指定用户，供公开资料视图使用。
   *
   * 与 `getSelf` 走同一条读取路径，差异只在 Controller 选了哪个投影；用户不存在同样抛
   * NOT_FOUND，不会因视图不同而改变失败语义。
   *
   * @param userId - 要读取的用户 ID，允许指向他人；字段裁剪由上层视图负责
   * @param signal - 请求生命周期绑定的取消信号，透传给仓储查询
   * @returns 领域用户实体；本层不做权限与字段裁剪
   */
  public getPublicUser(userId: string, signal: AbortSignal): Promise<User> {
    return this.#requireUser(userId, signal)
  }

  /**
   * 分页查询用户列表。
   *
   * 分页参数已在上游解析层归一化，此处不再夹取；无匹配时返回空列表，不抛错。
   *
   * @param offset - 起始偏移，非负整数
   * @param limit - 每页条数，上游已限制在 1..100
   * @param signal - 请求生命周期绑定的取消信号，透传给仓储查询
   * @returns 用户分页结果；`total` 是命中总数，与 `users` 长度无关
   */
  public listUsers(offset: number, limit: number, signal: AbortSignal): Promise<UserPage> {
    return this.#users.list(offset, limit, signal)
  }

  /**
   * 读取用户并在缺失时抛出稳定 NOT_FOUND 错误，Controller 据此映射 HTTP 404。
   *
   * 作为 `getSelf` 与 `getPublicUser` 的共同读取路径，保证两种视图的失败语义一致：
   * 视图差异只在投影，不存在时都是 404 而非空对象或 500。
   *
   * @param userId - 要读取的用户 ID；本方法只负责取用，归属校验由调用方保证
   * @param signal - 请求生命周期绑定的取消信号，透传给仓储查询
   * @returns 找到的领域用户实体；不存在时抛出而非返回 `undefined`
   */
  async #requireUser(userId: string, signal: AbortSignal): Promise<User> {
    const user = await this.#users.getById(userId, signal)
    if (user === undefined) {
      throw new IdentityApplicationError(IDENTITY_APPLICATION_ERROR_CODES.NOT_FOUND, '用户不存在')
    }
    return user
  }
}
