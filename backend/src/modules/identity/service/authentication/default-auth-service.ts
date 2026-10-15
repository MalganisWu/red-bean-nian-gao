import bcrypt from 'bcryptjs'
import { compactVerify, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'

import { AUTH_ERROR_CODES, AuthError, type User } from '../../model/user.js'
import type { AuthServicePort } from './port/auth-service.port.js'
import type { PasswordHasher } from './port/password-hasher.port.js'
import type { UserRepository } from '../user-repository/port/user-repository.port.js'

/** 访问令牌的默认有效期，24 小时；未显式配置时登录与续签都按它签发出 `exp`。 */
const DEFAULT_TOKEN_DURATION_MILLISECONDS = 24 * 60 * 60 * 1_000
/** 续签可接受的旧令牌最大年龄，7 天；保证过期的令牌仍有一段时间窗口可换取新令牌。 */
const DEFAULT_REFRESH_MAX_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000
/** 签发时间的时钟偏移容忍，60 秒；用于吸收签发方与校验方的系统时钟误差。 */
const CLOCK_SKEW_MILLISECONDS = 60 * 1_000
/** bcrypt 默认计算成本因子；取值以安全与响应的平衡为准，调高会显著拖慢登录。 */
const DEFAULT_BCRYPT_COST = 10

/**
 * JWT 载荷的形状校验：只允许声明中真正会被读取的三个字段。
 *
 * 用 Schema 而非直接断言，是因为令牌虽已验签，仍可能是由旧版本或异源签发、形状不符的合法签名；
 * 复核对齐 `TokenClaims`，让 `parseClaims` 之后的读取不必再做防御性判断。
 */
const claimsSchema = z.object({
  user_id: z.string().min(1),
  username: z.string(),
  iat: z.number().finite(),
})

/** 认证服务依赖；`now` 可注入，token 的有效期因此在测试里可以被推进。 */
export interface JwtAuthServiceOptions {
  /** 用户仓储；登录与续签都要读用户，验证凭据或确认账号仍然存在。 */
  readonly userRepository: UserRepository
  /** 密码散列器；登录时委托它校验口令，本服务不接触散列算法细节。 */
  readonly passwordHasher: PasswordHasher
  /** JWT 签名密钥原文；不得为空，构造时编码成字节，不落日志。 */
  readonly secret: string
  /** 访问令牌有效期（毫秒）；缺省或非正整数时回退到 24 小时。 */
  readonly tokenDurationMilliseconds?: number | undefined
  /** 续签可接受的旧令牌最大年龄（毫秒）；缺省或非正整数时回退到 7 天。 */
  readonly refreshMaxAgeMilliseconds?: number | undefined
  /**
   * 产生校验与签发的当前时间；可注入，测试据此推进令牌有效期。
   * @returns 当前时刻
   */
  readonly now?: (() => Date) | undefined
}

/**
 * 校验通过后从 JWT 载荷中取用的声明子集。
 *
 * `iat` 保留为秒级时间戳，续签时按它判定令牌年龄；字段名保持 JWT 的下划线风格，
 * 以免在编解码两端引入一层易错的改名。
 */
interface TokenClaims {
  /** 令牌声明的用户 ID；经 Schema 校验非空，用作读取用户的键。 */
  readonly user_id: string
  /** 令牌声明的用户名；仅作信息留存，鉴权只认 `user_id`。 */
  readonly username: string
  /** 签发时间，Unix 秒；续签的时钟偏移与最大年龄都以它为基准。 */
  readonly iat: number
}

/**
 * Identity Module 的密码散列生产实现，由 `identity.module.ts` 创建并持有计算成本。
 * hash/verify 失败均向上抛出且不记录明文；该无状态资源没有独立取消与关闭责任。
 */
export class BcryptPasswordHasher implements PasswordHasher {
  /** bcrypt 计算成本因子，构造时校验为正整数；固定后不再变化。 */
  readonly #cost: number

  public constructor(cost: number = DEFAULT_BCRYPT_COST) {
    if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error('bcrypt cost 必须为正')
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
    if (password === '') throw new Error('密码不能为空')
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
        throw new Error('密码不匹配')
      }
    } catch (cause: unknown) {
      throw new Error(`密码验证失败: ${normalizeError(cause).message}`, { cause })
    }
  }
}

/** `AuthServicePort` 的 JWT 实现，密码验证仍委托给注入的 PasswordHasher。 */
export class JwtAuthService implements AuthServicePort {
  /** 用户仓储，构造时注入；登录按用户名查、续签按 ID 查。 */
  readonly #userRepository: UserRepository
  /** 密码散列器，构造时注入；登录校验口令时委托它。 */
  readonly #passwordHasher: PasswordHasher
  /** 编码为字节的签名密钥，构造时由明文密钥一次转换，之后只作签名与验签用。 */
  readonly #secret: Uint8Array
  /** 生效的访问令牌有效期（毫秒），构造时按选项或默认值归一。 */
  readonly #tokenDurationMilliseconds: number
  /** 生效的续签最大年龄（毫秒），构造时按选项或默认值归一。 */
  readonly #refreshMaxAgeMilliseconds: number
  /**
   * 提供当前时间的时钟，构造时确定；默认取系统时钟，测试可注入固定实现。
   * @returns 当前时刻
   */
  readonly #now: () => Date

  public constructor(options: JwtAuthServiceOptions) {
    if (options.secret === '') throw new Error('JWT secret 不能为空')
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
      throw new Error(`查询用户失败：${normalizeError(cause).message}`, { cause })
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
      throw new Error(`刷新用户失败：${normalizeError(cause).message}`, { cause })
    }
    if (user === undefined || !user.isActive) {
      throw new AuthError(AUTH_ERROR_CODES.INVALID_TOKEN, 'invalid token')
    }
    return this.sign(user, now)
  }

  /**
   * 用当前用户与时间签发一枚 HS256 访问令牌。
   *
   * `nbf` 与 `iat` 取同一时刻，`exp` 由生效的有效期推出；载荷只放 `user_id` 与 `username`，
   * 不放角色等可变信息，避免旧令牌携带过期授权。
   *
   * @param user - 令牌归属的领域用户；取自 `user.id` 与 `user.username`
   * @param now - 本次签发的基准时间；由调用方取一次以复用同一时刻
   * @returns 签名后的 JWT 字符串
   */
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

/**
 * 把 JWT 载荷收窄为 `TokenClaims`，形状不符即抛错。
 *
 * 收窄后调用方读取 `user_id` 无需再判空；这里只做结构校验，不判定签名或有效期 ——
 * 那属于验签环节，职责分开以免复用本函数时误以为已经验签。
 *
 * @param value - 已解码的载荷原始值；可能来自 JSON.parse，类型未知
 * @returns 通过 Schema 校验的声明子集
 */
function parseClaims(value: unknown): TokenClaims {
  const parsed = claimsSchema.safeParse(value)
  if (!parsed.success) throw new Error('token claims 非法')
  return parsed.data
}

/**
 * 归一化时长配置：只接受正的安全整数，其余（未配置、0、负数、溢出）一律回退到默认值。
 *
 * 取「回退」而非抛错，是为了让配置缺失与手写配置出错都收敛到可用的默认时长，
 * 避免一个笔误让服务起不来。
 *
 * @param value - 调用方传入的时长（毫秒），可能缺省或非法
 * @param fallback - 非法时使用的默认时长（毫秒）
 * @returns 归一化后的正整数时长
 */
function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * 构造凭据错误的稳定异常，供登录失败的两条路径（账号不存在、密码不匹配）共用。
 *
 * 两条路径刻意返回同一错误码与同一文案，使调用方无法据错误区分账号是否存在，
 * 避免登录接口成为账号枚举的旁路。
 *
 * @returns 固定为 INVALID_CREDENTIALS 的认证异常
 */
function invalidCredentials(): AuthError {
  return new AuthError(AUTH_ERROR_CODES.INVALID_CREDENTIALS, 'invalid username or password')
}

/**
 * 判断未知异常是否带有指定的 `code`，用于识别 jose 抛出的库错误码。
 *
 * jose 的错误是带 `code` 的 Error 实例但未被导出为可 `instanceof` 的类型，只按错误码匹配；
 * 同时对非 Error 值与缺失 `code` 的情形一律返回 `false`，不误判成目标错误。
 *
 * @param value - 捕获到的未知异常
 * @param expected - 期望匹配的错误码字符串，如 `ERR_JWT_EXPIRED`
 * @returns 带该错误码时为 `true`
 */
function hasErrorCode(value: unknown, expected: string): boolean {
  return value instanceof Error && 'code' in value && value.code === expected
}
