import { API_ERROR_CODES } from '@red-bean/api-contract'

/** 构造 `AppError` 的入参；`message` 会进响应体，`logMessage`/`cause` 只进日志。 */
export interface AppErrorOptions {
  /** 返回给客户端的 HTTP 状态码，决定响应行。 */
  readonly httpStatus: number
  /** 信封里的业务错误码，取自 `API_ERROR_CODES`，供前端按键分支。 */
  readonly code: number
  /** 会原样进响应体的公开中文文案；不得携带内部实现细节。 */
  readonly message: string
  /** 只进服务端日志的补充说明；缺省时错误日志回落到通用文案。 */
  readonly logMessage?: string
  /** 原始错误，只进日志与排障、绝不进响应体；用于保留 cause 链。 */
  readonly cause?: unknown
}

/** 对外错误信封的形状；`data` 恒为 null，由 api-contract 固定。 */
export interface ErrorEnvelope {
  /** 响应行使用的 HTTP 状态码，由 `AppError.httpStatus` 映射而来。 */
  readonly status: number
  /** 对外错误信封体；形状 `{code, message, data: null}` 由 api-contract 固定，三个字段都不能少。 */
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
  /** 返回给客户端的 HTTP 状态码，决定响应行；由工厂函数按语义填好。 */
  public readonly httpStatus: number
  /** 信封里的业务错误码，取自 `API_ERROR_CODES`，供前端按键分支。 */
  public readonly code: number
  /** 只进服务端日志的补充说明；为 `undefined` 时错误日志回落到通用文案。 */
  public readonly logMessage: string | undefined
  /** 原始错误，仅用于日志与排障，绝不进响应体。 */
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

/**
 * 400：入参不合法。
 * @param message - 会原样进响应体的公开中文文案。
 * @returns 携带 400 与 `VALIDATION` 错误码的 `AppError`。
 */
export function validationError(message: string): AppError {
  return new AppError({ httpStatus: 400, code: API_ERROR_CODES.VALIDATION, message })
}

/**
 * 401：未认证或凭证无效。
 * @param message - 会原样进响应体的公开中文文案。
 * @returns 携带 401 与 `UNAUTHORIZED` 错误码的 `AppError`。
 */
export function unauthorizedError(message: string): AppError {
  return new AppError({ httpStatus: 401, code: API_ERROR_CODES.UNAUTHORIZED, message })
}

/**
 * 403：已认证但无权限。
 * @param message - 会原样进响应体的公开中文文案。
 * @returns 携带 403 与 `FORBIDDEN` 错误码的 `AppError`。
 */
export function forbiddenError(message: string): AppError {
  return new AppError({ httpStatus: 403, code: API_ERROR_CODES.FORBIDDEN, message })
}

/**
 * 404：资源不存在。越权场景也复用它，以免暴露「存在但不属于你」。
 * @param message - 会原样进响应体的公开中文文案。
 * @returns 携带 404 与 `NOT_FOUND` 错误码的 `AppError`。
 */
export function notFoundError(message: string): AppError {
  return new AppError({ httpStatus: 404, code: API_ERROR_CODES.NOT_FOUND, message })
}

/**
 * 409：与当前状态冲突（如交互已被处理）。
 * @param message - 会原样进响应体的公开中文文案。
 * @returns 携带 409 与 `CONFLICT` 错误码的 `AppError`。
 */
export function conflictError(message: string): AppError {
  return new AppError({ httpStatus: 409, code: API_ERROR_CODES.CONFLICT, message })
}

/**
 * 429：限流。复用 `CONFLICT` 错误码是因为契约里没有单独的限流码，前端按 HTTP 状态分支即可。
 * @param message - 会原样进响应体的公开中文文案。
 * @returns 携带 429 与 `CONFLICT` 错误码的 `AppError`。
 */
export function rateLimitError(message: string): AppError {
  return new AppError({ httpStatus: 429, code: API_ERROR_CODES.CONFLICT, message })
}

/**
 * 413：请求体超过限制。
 * @param message - 会原样进响应体的公开中文文案。
 * @returns 携带 413 与 `VALIDATION` 错误码的 `AppError`。
 */
export function payloadTooLargeError(message: string): AppError {
  return new AppError({ httpStatus: 413, code: API_ERROR_CODES.VALIDATION, message })
}

/**
 * 500：通用内部错误；不接收 message，避免调用方顺手把内部细节传进来。
 * @returns 携带 500 与 `INTERNAL` 错误码、固定通用文案的 `AppError`。
 */
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
 * @param logMessage - 只进日志的说明，帮助定位是哪个环节的未知错误。
 * @param cause - 原始错误，只进日志、绝不进响应体。
 * @returns 携带 500 与 `INTERNAL` 错误码的 `AppError`。
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
 * @param error - 任意抛出的错误；`AppError` 按其语义映射，其余降级为通用 500。
 * @returns 含 HTTP 状态码与 `{code, message, data: null}` 信封体的映射结果。
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
