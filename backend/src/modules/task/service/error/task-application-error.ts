/** Task Application Service 向传输层暴露的稳定错误分类。 */
export const TASK_APPLICATION_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'task_not_found',
  FORBIDDEN: 'task_forbidden',
  EXECUTION_NOT_FOUND: 'task_execution_not_found',
  INFRASTRUCTURE: 'task_infrastructure_failure',
} as const)

/** 用例错误码的字面量联合。 */
export type TaskApplicationErrorCode =
  (typeof TASK_APPLICATION_ERROR_CODES)[keyof typeof TASK_APPLICATION_ERROR_CODES]

/** 隔离 Repository 错误与 HTTP 错误，避免 Controller 承担业务授权。 */
export class TaskApplicationError extends Error {
  public readonly code: TaskApplicationErrorCode

  public constructor(code: TaskApplicationErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TaskApplicationError'
    this.code = code
  }
}

/** 基础设施失败统一分类为 INFRASTRUCTURE，保留原始原因供日志定位。 */
export function infrastructureFailure(message: string, cause: unknown): TaskApplicationError {
  return new TaskApplicationError(TASK_APPLICATION_ERROR_CODES.INFRASTRUCTURE, message, cause)
}
