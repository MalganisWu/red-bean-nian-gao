/** Storage 用例的错误码：入参不合法与对象不存在。 */
export const STORAGE_APPLICATION_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'storage_invalid_input',
  NOT_FOUND: 'storage_not_found',
} as const)

/** 错误码的字面量联合。 */
export type StorageApplicationErrorCode =
  (typeof STORAGE_APPLICATION_ERROR_CODES)[keyof typeof STORAGE_APPLICATION_ERROR_CODES]

/** Storage 用例统一使用的稳定错误，Controller 只按错误码映射 HTTP 语义。 */
export class StorageApplicationError extends Error {
  /** 稳定错误码：Controller 只按它映射 HTTP 语义（入参非法→400、不存在→404），不解析 message。 */
  public readonly code: StorageApplicationErrorCode

  public constructor(code: StorageApplicationErrorCode, message: string) {
    super(message)
    this.name = 'StorageApplicationError'
    this.code = code
  }
}
