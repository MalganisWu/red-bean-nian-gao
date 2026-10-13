import bcrypt from 'bcryptjs'
import { compactVerify, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'

import { AUTH_ERROR_CODES, AuthError, type User } from '../../model/user.js'
import type { AuthServicePort } from './port/auth-service.port.js'
import type { PasswordHasher } from './port/password-hasher.port.js'
import type { UserRepository } from '../user-repository/port/user-repository.port.js'

const DEFAULT_TOKEN_DURATION_MILLISECONDS = 24 * 60 * 60 * 1_000
const DEFAULT_REFRESH_MAX_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000
const CLOCK_SKEW_MILLISECONDS = 60 * 1_000
const DEFAULT_BCRYPT_COST = 10

const claimsSchema = z.object({
  user_id: z.string().min(1),
  username: z.string(),
  iat: z.number().finite(),
})

/** 认证服务依赖；`now` 可注入，token 的有效期因此在测试里可以被推进。 */
export interface JwtAuthServiceOptions {
  readonly userRepository: UserRepository
  readonly passwordHasher: PasswordHasher
  readonly secret: string
  readonly tokenDurationMilliseconds?: number | undefined
  readonly refreshMaxAgeMilliseconds?: number | undefined
  readonly now?: (() => Date) | undefined
}

interface TokenClaims {
  readonly user_id: string
  readonly username: string
  readonly iat: number
}

/**
 * Identity Module 的密码散列生产实现，由 `identity.module.ts` 创建并持有计算成本。
 * hash/verify 失败均向上抛出且不记录明文；该无状态资源没有独立取消与关闭责任。
 */
export class BcryptPasswordHasher implements PasswordHasher {
  readonly #cost: number

  public constructor(cost: number = DEFAULT_BCRYPT_COST) {
    if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error('bcrypt cost must be positive')
    this.#cost = cost
  }

  /**
   * 计算密码散列。
   *
   * 空密码直接拒绝，不消耗一次 bcrypt 计算；底层异常包装后重抛，明文既不进错误信息也不落日志。
   *
   * @param password - 待散列的明文密码；仅在本调用栈内存在，不被保存或记录
   * @returns bcrypt 散列串，已含盐与成本参数，可直接入库
   */
  public async hash(password: string): Promise<string> {
    if (password === '') throw new Error('password cannot be empty')
    try {
      return await bcrypt.hash(password, this.#cost)
    } catch (cause: unknown) {
      throw new Error(`密码加密失败: ${normalizeError(cause).message}`, { cause })
    }
  }

  /**
   * 校验明文密码与散列是否匹配，不匹配即抛错。
   *
   * 失败原因刻意不细分：无论散列非法还是口令不符都抛出同一类错误，避免成为口令探测的旁路。
   *
   * @param hashedPassword - 库中存储的散列串；格式非法时按不匹配处理
   * @param plainPassword - 待校验的明文密码，仅在本调用栈内存在
   */
  public async verify(hashedPassword: string, plainPassword: string): Promise<void> {
    try {
      if (!(await bcrypt.compare(plainPassword, hashedPassword))) {
        throw new Error('password mismatch')
      }
    } catch (cause: unknown) {
      throw new Error(`密码验证失败: ${normalizeError(cause).message}`, { cause })
    }
  }
}

/** `AuthServicePort` 的 JWT 实现，密码验证仍委托给注入的 PasswordHasher。 */
export class JwtAuthService implements AuthServicePort {
  readonly #userRepository: UserRepository
  readonly #passwordHasher: PasswordHasher
  readonly #secret: Uint8Array
  readonly #tokenDurationMilliseconds: number
  readonly #refreshMaxAgeMilliseconds: number
  readonly #now: () => Date

  public constructor(options: JwtAuthServiceOptions) {
    if (options.secret === '') throw new Error('JWT secret must not be empty')
    this.#userRepository = options.userRepository
    this.#passwordHasher = options.passwordHasher
    this.#secret = new TextEncoder().encode(options.secret)
    this.#tokenDurationMilliseconds = positiveDuration(
      options.tokenDurationMilliseconds,
      DEFAULT_TOKEN_DURATION_MILLISECONDS
    )
    this.#refreshMaxAgeMilliseconds = positiveDuration(
      options.refreshMaxAgeMilliseconds,
      DEFAULT_REFRESH_MAX_AGE_MILLISECONDS
    )
    this.#now = options.now ?? ((): Date => new Date())
  }

  /**
   * 校验用户名密码并签发访问令牌。
   *
   * 账号不存在、密码不匹配、账号停用分别产生稳定的 AuthError 码；仓储异常包装为普通错误，
   * 由上层统一收敛为 401，不向调用方区分具体原因。
   *
   * @param username - 登录用户名；查询失败按凭据错误处理，不暴露账号是否存在
   * @param password - 明文密码，交给注入的散列器校验，不被记录
   * @param signal - 取消信号；进入时先检查，并透传给用户查询
   * @returns 签名后的访问令牌
   */
  public async login(username: string, password: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    let user: User | undefined
    try {
      user = await this.#userRepository.getByUsername(username, signal)
    } catch (cause: unknown) {
      throw new Error(`failed to get user: ${normalizeError(cause).message}`, { cause })
    }
    if (user === undefined) throw invalidCredentials()
    try {
      await this.#passwordHasher.verify(user.passwordHash, password)
    } catch {
      throw invalidCredentials()
    }
    if (!user.isActive) {
      throw new AuthError(AUTH_ERROR_CODES.ACCOUNT_DISABLED, 'account is disabled')
    }
    return this.sign(user, this.#now())
  }

  /**
   * 注销令牌。
   *
   * 当前是无状态占位实现：JWT 无法被服务端撤销，这里只做取消检查后直接返回；令牌在过期前
   * 仍然可用，真正的失效依赖到期或后续引入的吊销表。
   *
   * @param _token - 待注销的令牌原文；无状态实现下不使用，保留占位以便未来接入吊销
   * @param signal - 取消信号，仅用于进入时检查，后续无异步操作
   */
  public logout(_token: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.resolve()
  }

  /**
   * 校验令牌签名与有效期，返回其声明的用户 ID。
   *
   * 过期与其它非法原因被拆成 TOKEN_EXPIRED 与 INVALID_TOKEN 两个稳定码，上层可据此做差异化
   * 处理（如静默续签）；载荷再经 Schema 复核，防止形状异常的伪造 claim 穿透。
   *
   * @param token - 待校验的 JWT 原文，来自 Authorization 头
   * @param signal - 取消信号；进入时先检查
   * @returns 令牌中经校验的 `user_id`
   */
  public async validateToken(token: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    try {
      const verified = await jwtVerify(token, this.#secret, {
        algorithms: ['HS256'],
        currentDate: this.#now(),
      })
      return parseClaims(verified.payload).user_id
    } catch (cause: unknown) {
      if (hasErrorCode(cause, 'ERR_JWT_EXPIRED')) {
        throw new AuthError(AUTH_ERROR_CODES.TOKEN_EXPIRED, 'token expired', cause)
      }
      throw new AuthError(AUTH_ERROR_CODES.INVALID_TOKEN, 'invalid token', cause)
    }
  }

  /**
   * 用旧令牌换取新令牌，延长会话。
   *
   * 与 `validateToken` 的分工：这里刻意接受**已过期**的令牌（只验签名），但签发时间受时钟偏移
   * 容忍与 refresh 最大年龄双重约束；用户不存在或已停用一律按 INVALID_TOKEN 拒绝。
   *
   * @param oldToken - 待续签的旧令牌原文；允许已过期，但签名必须有效
   * @param signal - 取消信号；进入时先检查，并透传给用户查询
   * @returns 重新签发的访问令牌
   */
  public async refreshToken(oldToken: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    let claims: TokenClaims
    try {
      const verified = await compactVerify(oldToken, this.#secret, { algorithms: ['HS256'] })
      claims = parseClaims(JSON.parse(new TextDecoder().decode(verified.payload)))
    } catch (cause: unknown) {
      throw new AuthError(AUTH_ERROR_CODES.INVALID_TOKEN, 'invalid token', cause)
    }

    const now = this.#now()
    const issuedAtMilliseconds = claims.iat * 1_000
    if (
      issuedAtMilliseconds > now.getTime() + CLOCK_SKEW_MILLISECONDS ||
      now.getTime() - issuedAtMilliseconds > this.#refreshMaxAgeMilliseconds
    ) {
      throw new AuthError(AUTH_ERROR_CODES.TOKEN_EXPIRED, 'token expired')
    }

    let user: User | undefined
    try {
      user = await this.#userRepository.getById(claims.user_id, signal)
    } catch (cause: unknown) {
      throw new Error(`failed to refresh user: ${normalizeError(cause).message}`, { cause })
    }
    if (user === undefined || !user.isActive) {
      throw new AuthError(AUTH_ERROR_CODES.INVALID_TOKEN, 'invalid token')
    }
    return this.sign(user, now)
  }

  private sign(user: User, now: Date): Promise<string> {
    const issuedAt = Math.floor(now.getTime() / 1_000)
    const expiresAt = Math.floor((now.getTime() + this.#tokenDurationMilliseconds) / 1_000)
    return new SignJWT({ user_id: user.id, username: user.username })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.#secret)
  }
}

function parseClaims(value: unknown): TokenClaims {
  const parsed = claimsSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid token claims')
  return parsed.data
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function invalidCredentials(): AuthError {
  return new AuthError(AUTH_ERROR_CODES.INVALID_CREDENTIALS, 'invalid username or password')
}

function hasErrorCode(value: unknown, expected: string): boolean {
  return value instanceof Error && 'code' in value && value.code === expected
}
