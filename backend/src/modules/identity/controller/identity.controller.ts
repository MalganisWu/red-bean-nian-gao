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

  public async login(input: LoginDto, signal: AbortSignal): Promise<TokenDto> {
    try {
      const token = await this.#authentication.login(input.username, input.password, signal)
      return { token }
    } catch {
      throw unauthorizedError('用户名或密码错误')
    }
  }

  public async logout(token: string, signal: AbortSignal): Promise<{ readonly message: string }> {
    try {
      await this.#authentication.logout(token, signal)
    } catch (cause: unknown) {
      throw loggedInternalError('登出失败', cause)
    }
    return { message: '已退出登录' }
  }

  public async refresh(token: string, signal: AbortSignal): Promise<TokenDto> {
    try {
      return { token: await this.#authentication.refreshToken(token, signal) }
    } catch {
      throw unauthorizedError('认证凭证无效')
    }
  }

  public async self(userId: string, signal: AbortSignal): Promise<SelfUserDto> {
    try {
      return toSelfUserDto(await this.#profiles.getSelf(userId, signal))
    } catch (cause: unknown) {
      throw mapIdentityFailure(cause, '查询用户失败')
    }
  }

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

  public async detail(targetUserId: string, signal: AbortSignal): Promise<PublicUserDto> {
    try {
      return toPublicUserDto(await this.#profiles.getPublicUser(targetUserId, signal))
    } catch (cause: unknown) {
      throw mapIdentityFailure(cause, '查询用户失败')
    }
  }

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
