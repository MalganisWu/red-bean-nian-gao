import type {
  LoginDto,
  PublicUserDto,
  RegisterUserDto,
  SelfUserDto,
  TokenDto,
  UpdateSelfDto,
} from './identity.dto.js'

import {
  IDENTITY_APPLICATION_ERROR_CODES,
  IdentityApplicationError,
} from '../service/application/error/identity-application-error.js'
import type { IdentityProfileService } from '../service/application/profile/identity-profile-service.js'
import type { IdentityRegistrationService } from '../service/application/registration/identity-registration-service.js'
import type { AuthServicePort } from '../service/authentication/port/auth-service.port.js'
import {
  conflictError,
  loggedInternalError,
  notFoundError,
  unauthorizedError,
} from '../../../shared/http/error-mapper.js'
import { toPublicUserDto, toSelfUserDto } from './identity-presenter.js'
import { optionalField } from '../../../shared/object/optional-field.js'

/** Controller 的三个用例服务依赖；Controller 不感知仓储与散列的具体实现。 */
export interface IdentityControllerDependencies {
  readonly registration: IdentityRegistrationService
  readonly authentication: AuthServicePort
  readonly profiles: IdentityProfileService
}

/**
 * Identity 的 HTTP 用例控制器：方法签名即"入参 + 返回"，不接触 Fastify 类型；负责 DTO 投影与应用错误映射。
 * 请求解包、Principal/Bearer 提取与成功信封输出由 `identity.routes.ts` 承担。
 */
export class IdentityController {
  readonly #registration: IdentityRegistrationService
  readonly #authentication: AuthServicePort
  readonly #profiles: IdentityProfileService

  public constructor(dependencies: IdentityControllerDependencies) {
    this.#registration = dependencies.registration
    this.#authentication = dependencies.authentication
    this.#profiles = dependencies.profiles
  }

  /**
   * 注册新用户并回吐其自有视图。
   *
   * 失败语义集中在 `mapIdentityFailure`：用户名/邮箱冲突映射 409，其余未知异常落 500
   * （写日志并保留 cause），不会把仓储或散列的内部错误直接暴露成响应体。
   *
   * @param input - 已通过 Schema 的注册 DTO；密码在此仍为明文，散列由用例层完成，控制器不落库
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 含邮箱的新用户自有视图，可直接进成功信封
   */
  public async register(input: RegisterUserDto, signal: AbortSignal): Promise<SelfUserDto> {
    try {
      const user = await this.#registration.register(
        {
          username: input.username,
          email: input.email,
          password: input.password,
          displayName: input.display_name,
          ...optionalField('avatar', input.avatar),
        },
        signal
      )
      return toSelfUserDto(user)
    } catch (cause: unknown) {
      throw mapIdentityFailure(cause, '创建用户失败')
    }
  }

  /**
   * 校验登录凭据并签发访问令牌。
   *
   * 所有失败（账号不存在、密码不匹配、底层异常）都收敛为同一个 401，响应刻意不区分原因，
   * 以免成为账号枚举的旁路。
   *
   * @param input - 已通过 Schema 的登录 DTO；形状合法不代表凭据正确，正确性由认证服务判定
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 签发的访问令牌 DTO
   */
  public async login(input: LoginDto, signal: AbortSignal): Promise<TokenDto> {
    try {
      const token = await this.#authentication.login(input.username, input.password, signal)
      return { token }
    } catch {
      throw unauthorizedError('用户名或密码错误')
    }
  }

  /**
   * 注销当前令牌，使对应会话失效。
   *
   * 失败统一落 500（写日志保留 cause）：登出失败属于服务端问题，不应误导调用方去重新登录。
   *
   * @param token - 从 Authorization 头解析出的 Bearer 令牌原文；该端点不经 auth 前置处理器，需显式传入
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 固定文案的登出回执，不含会话细节
   */
  public async logout(token: string, signal: AbortSignal): Promise<{ readonly message: string }> {
    try {
      await this.#authentication.logout(token, signal)
    } catch (cause: unknown) {
      throw loggedInternalError('登出失败', cause)
    }
    return { message: '已退出登录' }
  }

  /**
   * 用未过期的令牌换取新令牌，延长会话。
   *
   * 令牌无效或已过期一律映射为 401，与登录失败保持同一语义，调用方据此走重新登录。
   *
   * @param token - 从 Authorization 头解析出的 Bearer 令牌原文；同样不经 auth 前置处理器
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 续签后的访问令牌 DTO
   */
  public async refresh(token: string, signal: AbortSignal): Promise<TokenDto> {
    try {
      return { token: await this.#authentication.refreshToken(token, signal) }
    } catch {
      throw unauthorizedError('认证凭证无效')
    }
  }

  /**
   * 读取当前登录用户自己的资料。
   *
   * 归属由此固定：读取目标必须是 Principal 携带的 userId，不接受请求体或查询串改写，
   * 从签名层面杜绝「传入他人 id 读他人资料」。查不到时按 NOT_FOUND 映射 404。
   *
   * @param userId - 由鉴权层从令牌中提取的当前 Principal 用户 ID，是唯一的读取目标
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 含邮箱的自有视图，仅回给用户本人
   */
  public async self(userId: string, signal: AbortSignal): Promise<SelfUserDto> {
    try {
      return toSelfUserDto(await this.#profiles.getSelf(userId, signal))
    } catch (cause: unknown) {
      throw mapIdentityFailure(cause, '查询用户失败')
    }
  }

  /**
   * 更新当前登录用户自己的资料。
   *
   * 与 `self` 同一归属约定：写入目标只取 Principal 的 userId，请求体只能携带要改的字段，
   * 无法指向他人。字段缺席表示「不改」，与显式置空由用例层区分处理。
   *
   * @param input - 已通过 Schema 的更新 DTO；只含本请求要改动的字段
   * @param userId - 由鉴权层提取的当前 Principal 用户 ID，是唯一的写入目标
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 更新后的自有视图，含邮箱
   */
  public async updateSelf(
    input: UpdateSelfDto,
    userId: string,
    signal: AbortSignal
  ): Promise<SelfUserDto> {
    try {
      const user = await this.#profiles.updateSelf(
        {
          userId,
          ...optionalField('displayName', input.display_name),
          ...optionalField('avatar', input.avatar),
          ...optionalField('email', input.email),
        },
        signal
      )
      return toSelfUserDto(user)
    } catch (cause: unknown) {
      throw mapIdentityFailure(cause, '更新用户失败')
    }
  }

  /**
   * 读取任意指定用户的公开资料（仍需已登录）。
   *
   * 与 `self` 的区别只在投影方向：这里刻意走公开视图，邮箱等敏感字段不出现在响应里；
   * 目标不存在映射 404。
   *
   * @param targetUserId - 由路径参数解析出的目标用户 ID，允许指向他人
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 目标用户的公开视图，不含邮箱
   */
  public async detail(targetUserId: string, signal: AbortSignal): Promise<PublicUserDto> {
    try {
      return toPublicUserDto(await this.#profiles.getPublicUser(targetUserId, signal))
    } catch (cause: unknown) {
      throw mapIdentityFailure(cause, '查询用户失败')
    }
  }

  /**
   * 分页列出用户，统一投影为公开视图。
   *
   * 只做投影与信封组装，分页参数已在解析层归一化，此处不再夹取；查询异常落 500。
   *
   * @param offset - 归一化后的起始偏移，非负整数
   * @param limit - 归一化后的每页条数，解析层已夹在 1..100
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给下游用例
   * @returns 公开视图分页结果；`total` 是全量命中数，不受本页条数影响
   */
  public async list(
    offset: number,
    limit: number,
    signal: AbortSignal
  ): Promise<{
    readonly users: PublicUserDto[]
    readonly total: number
    readonly offset: number
    readonly limit: number
  }> {
    try {
      const page = await this.#profiles.listUsers(offset, limit, signal)
      return { users: page.users.map(toPublicUserDto), total: page.total, offset, limit }
    } catch (cause: unknown) {
      throw loggedInternalError('查询用户列表失败', cause)
    }
  }
}

function mapIdentityFailure(cause: unknown, fallback: string): Error {
  if (cause instanceof IdentityApplicationError) {
    if (cause.code === IDENTITY_APPLICATION_ERROR_CODES.CONFLICT)
      return conflictError(cause.message)
    if (cause.code === IDENTITY_APPLICATION_ERROR_CODES.NOT_FOUND)
      return notFoundError(cause.message)
  }
  return loggedInternalError(fallback, cause)
}
