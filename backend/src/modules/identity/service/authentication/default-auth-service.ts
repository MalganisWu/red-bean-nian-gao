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

  public async hash(password: string): Promise<string> {
    if (password === '') throw new Error('password cannot be empty')
    try {
      return await bcrypt.hash(password, this.#cost)
    } catch (cause: unknown) {
      throw new Error(`密码加密失败: ${normalizeError(cause).message}`, { cause })
    }
  }

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

  public logout(_token: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.resolve()
  }

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
