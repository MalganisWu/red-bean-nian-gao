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

export interface UserPage {
  readonly users: readonly User[]
  readonly total: number
}

export const AUTH_ERROR_CODES = Object.freeze({
  INVALID_TOKEN: 'invalid_token',
  TOKEN_EXPIRED: 'token_expired',
  INVALID_CREDENTIALS: 'invalid_credentials',
  ACCOUNT_DISABLED: 'account_disabled',
} as const)

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES]

export class AuthError extends Error {
  public readonly code: AuthErrorCode

  public constructor(code: AuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AuthError'
    this.code = code
  }
}
