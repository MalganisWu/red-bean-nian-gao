import { API_ERROR_CODES } from '@red-bean/api-contract'

export interface AppErrorOptions {
  readonly httpStatus: number
  readonly code: number
  readonly message: string
  readonly logMessage?: string
  readonly cause?: unknown
}

export interface ErrorEnvelope {
  readonly status: number
  readonly body: {
    readonly code: number
    readonly message: string
    readonly data: null
  }
}

/**
 * 可安全向客户端返回公开文案的应用错误。
 *
 * 三个字段的边界是这个类的全部意义，别混用：
 * - `message`：**会原样进响应体**，必须是可以公开的中文文案。
 * - `logMessage` / `cause`：只进服务端日志，绝不进响应。
 * 因此「把内部错误直接当 AppError 抛出」是一条会泄漏实现细节的路径——
 * 未知错误一律经 `loggedInternalError` 转换，见文件末尾的 `errorResponse`。
 */
export class AppError extends Error {
  public readonly httpStatus: number
  public readonly code: number
  public readonly logMessage: string | undefined
  public override readonly cause: unknown

  public constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause })
    this.name = 'AppError'
    this.httpStatus = options.httpStatus
    this.code = options.code
    this.logMessage = options.logMessage
    this.cause = options.cause
  }
}

export function validationError(message: string): AppError {
  return new AppError({ httpStatus: 400, code: API_ERROR_CODES.VALIDATION, message })
}

export function unauthorizedError(message: string): AppError {
  return new AppError({ httpStatus: 401, code: API_ERROR_CODES.UNAUTHORIZED, message })
}

export function forbiddenError(message: string): AppError {
  return new AppError({ httpStatus: 403, code: API_ERROR_CODES.FORBIDDEN, message })
}

export function notFoundError(message: string): AppError {
  return new AppError({ httpStatus: 404, code: API_ERROR_CODES.NOT_FOUND, message })
}

export function conflictError(message: string): AppError {
  return new AppError({ httpStatus: 409, code: API_ERROR_CODES.CONFLICT, message })
}

export function rateLimitError(message: string): AppError {
  return new AppError({ httpStatus: 429, code: API_ERROR_CODES.CONFLICT, message })
}

export function payloadTooLargeError(message: string): AppError {
  return new AppError({ httpStatus: 413, code: API_ERROR_CODES.VALIDATION, message })
}

export function internalError(): AppError {
  return new AppError({
    httpStatus: 500,
    code: API_ERROR_CODES.INTERNAL,
    message: '服务器内部错误',
  })
}

/**
 * 把未知错误包装成 500，**保留 cause 供日志、对外仍只给通用文案**。
 * 这是内部错误进入 HTTP 层的唯一合法通道。
 */
export function loggedInternalError(logMessage: string, cause: unknown): AppError {
  return new AppError({
    httpStatus: 500,
    code: API_ERROR_CODES.INTERNAL,
    message: '服务器内部错误',
    logMessage,
    cause,
  })
}

/**
 * 构造对外的错误信封。非 `AppError` 一律降级为通用 500——
 * 这里如果顺手把 `error.message` 传出去，一个未预期的 TypeError 就会把内部结构暴露给调用方。
 * 信封形状 `{code, message, data: null}` 由 api-contract 固定，三个字段都不能少。
 */
export function errorResponse(error: unknown): ErrorEnvelope {
  const safeError = error instanceof AppError ? error : internalError()
  return {
    status: safeError.httpStatus,
    body: {
      code: safeError.code,
      message: safeError.message,
      data: null,
    },
  }
}
