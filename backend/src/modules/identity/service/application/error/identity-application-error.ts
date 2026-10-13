/** Identity 用例的错误码；只收「冲突」与「不存在」两类，其余失败原样上抛。 */
export const IDENTITY_APPLICATION_ERROR_CODES = Object.freeze({
  CONFLICT: 'identity_conflict',
  NOT_FOUND: 'identity_not_found',
} as const)

/** 错误码的字面量联合。 */
export type IdentityApplicationErrorCode =
  (typeof IDENTITY_APPLICATION_ERROR_CODES)[keyof typeof IDENTITY_APPLICATION_ERROR_CODES]

/** Identity 用例统一使用的稳定错误，Controller 只按错误码映射 HTTP 语义。 */
export class IdentityApplicationError extends Error {
  /** 稳定错误码：Controller 只按它映射 HTTP 语义（冲突→409、不存在→404），不解析 message。 */
  public readonly code: IdentityApplicationErrorCode

  public constructor(code: IdentityApplicationErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'IdentityApplicationError'
    this.code = code
  }
}
