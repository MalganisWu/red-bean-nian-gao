/** 前后端共享的稳定业务错误码。 */
export const API_ERROR_CODES = {
  VALIDATION: 4001,
  UNAUTHORIZED: 4002,
  FORBIDDEN: 4003,
  NOT_FOUND: 4004,
  CONFLICT: 4009,
  INTERNAL: 5000,
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]
