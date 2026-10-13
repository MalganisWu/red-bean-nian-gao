/** 用户聚合；`email`/`displayName`/`avatar`/`isActive` 可改，身份字段（id、username、createdAt）不可改。 */
export interface User {
  /** 主键；由组装层注入的 ID 生成器产生，创建后不可变。 */
  readonly id: string
  /** 登录名；全局唯一，创建后不可改，是账号枚举防护要覆盖的字段之一。 */
  readonly username: string
  /** 邮箱；可改，但用例层需维护唯一性约束。 */
  email: string
  /** 密码散列后的密文；绝不外泄，出库即以此为唯一存放形态。 */
  readonly passwordHash: string
  /** 展示名；可改，缺省时由注册用例决定取值。 */
  displayName: string
  /** 头像地址；未设置时为 `undefined`，与「显式清空」由用例层区分。 */
  avatar?: string | undefined
  /** 账号是否启用；停用的账号不得通过认证，判定在认证服务的实现里。 */
  isActive: boolean
  /** 创建时间；由注入的时钟产生，创建后不可变。 */
  readonly createdAt: Date
  /** 最近更新时间；每次写操作由用例层刷新。 */
  updatedAt: Date
}

/** 用户分页结果；`total` 是符合查询条件的总数，不是 `users` 的长度。 */
export interface UserPage {
  /** 当前页的用户记录；已按仓储的排序规则截取，长度可能小于 `total`。 */
  readonly users: readonly User[]
  /** 符合查询条件的总记录数；不受本页条数影响，用于计算总页数。 */
  readonly total: number
}

/** 认证失败的稳定错误码；用例层据此决定 HTTP 状态与对外文案。 */
export const AUTH_ERROR_CODES = Object.freeze({
  INVALID_TOKEN: 'invalid_token',
  TOKEN_EXPIRED: 'token_expired',
  INVALID_CREDENTIALS: 'invalid_credentials',
  ACCOUNT_DISABLED: 'account_disabled',
} as const)

/** 认证错误码的字面量联合。 */
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES]

/** 认证异常；`code` 是机器判据，`message` 只供日志，不进响应体。 */
export class AuthError extends Error {
  /** 机器判据：记录失败类别，供上层映射 HTTP 语义；`message` 只进日志，不得进响应体。 */
  public readonly code: AuthErrorCode

  public constructor(code: AuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AuthError'
    this.code = code
  }
}
