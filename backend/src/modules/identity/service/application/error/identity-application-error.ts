export const IDENTITY_APPLICATION_ERROR_CODES = Object.freeze({
  CONFLICT: 'identity_conflict',
  NOT_FOUND: 'identity_not_found',
} as const)

export type IdentityApplicationErrorCode =
  (typeof IDENTITY_APPLICATION_ERROR_CODES)[keyof typeof IDENTITY_APPLICATION_ERROR_CODES]

/** Identity 用例统一使用的稳定错误，Controller 只按错误码映射 HTTP 语义。 */
export class IdentityApplicationError extends Error {
  public readonly code: IdentityApplicationErrorCode

  public constructor(code: IdentityApplicationErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'IdentityApplicationError'
    this.code = code
  }
}
