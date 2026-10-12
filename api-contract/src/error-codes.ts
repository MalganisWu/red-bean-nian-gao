/** 前后端共享的稳定业务错误码。 */
export const API_ERROR_CODES = {
  VALIDATION: 4001,
  UNAUTHORIZED: 4002,
  FORBIDDEN: 4003,
  NOT_FOUND: 4004,
  CONFLICT: 4009,
  INTERNAL: 5000,
} as const

/** 业务错误码的字面量联合；数值会原样发给客户端，改动等同破坏兼容性。 */
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]
