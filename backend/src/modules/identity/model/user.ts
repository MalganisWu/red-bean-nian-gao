/** 用户聚合；`email`/`displayName`/`avatar`/`isActive` 可改，身份字段（id、username、createdAt）不可改。 */
export interface User {
  readonly id: string
  readonly username: string
  email: string
  readonly passwordHash: string
  displayName: string
  avatar?: string | undefined
  isActive: boolean
  readonly createdAt: Date
  updatedAt: Date
}

/** 用户分页结果；`total` 是符合查询条件的总数，不是 `users` 的长度。 */
export interface UserPage {
  readonly users: readonly User[]
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
  public readonly code: AuthErrorCode

  public constructor(code: AuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AuthError'
    this.code = code
  }
}
