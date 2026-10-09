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

/** 可安全向客户端返回公开文案的应用错误。 */
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

export function loggedInternalError(logMessage: string, cause: unknown): AppError {
  return new AppError({
    httpStatus: 500,
    code: API_ERROR_CODES.INTERNAL,
    message: '服务器内部错误',
    logMessage,
    cause,
  })
}

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
