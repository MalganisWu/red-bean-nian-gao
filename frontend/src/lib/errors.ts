import { API_ERROR_CODES } from '@red-bean/api-contract'

// ── 前端错误域：AppError 类 + 错误解析工具 ──────────────────
// 原分散在 types/errors.ts（运行时类误入类型目录）与 services/api/error-parser.ts，
// 收拢为同一事实来源；store 层与 HTTP 客户端的错误处理都从这里取。

/** 后端统一错误格式：{code, message, data: null} */
export interface ApiError {
  /** 后端业务码（4001-5000），与 HTTP status 解耦。 */
  code: number
  /** 可直接展示的错误消息。 */
  message: string
  /** 附加数据；本错误格式约定为 null，缺省表示无。 */
  data?: unknown
}

export { API_ERROR_CODES }

/** 前端统一错误类型；`status` 是 HTTP 状态、`code` 是后端业务码，二者解耦。 */
export class AppError extends Error {
  /** HTTP 状态码；与业务码 `code` 解耦，供按传输层语义分流（如 401 触发重新登录）。 */
  status: number
  /** 后端业务码（4001-5000），与 HTTP status 解耦，供按码分流（i18n/重试） */
  code: number | undefined

  constructor(message: string, status: number, code?: number) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'AppError'
  }
}

/**
 * 后端统一错误格式 {code, message, data: null} → 提取业务码 + 安全文案
 *
 * @param body - 未校验的响应体解析结果；形状不符时回退通用文案与 INTERNAL 码，绝不抛出。
 * @returns 可直接展示的 message 与业务码 code。
 */
export function parseApiError(body: unknown): { message: string; code: number } {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    if (typeof body.message === 'string') {
      const code =
        'code' in body && typeof body.code === 'number' ? body.code : API_ERROR_CODES.INTERNAL
      return { message: body.message, code }
    }
  }
  return { message: '服务器错误，请稍后重试', code: API_ERROR_CODES.INTERNAL }
}

/**
 * 从请求抛出物中提取用户可读消息：AppError/Error 用其 message，其余回退兜底文案。
 * store 层 catch 的统一入口（chat/task 共用），保证三态 error 文案一致。
 *
 * @param e - catch 到的抛出物；非 Error 形态（字符串、对象等）一律回退兜底文案，不泄漏内部结构。
 * @returns 用户可读的错误消息。
 */
export function extractErrorMessage(e: unknown): string {
  if (e instanceof AppError) return e.message
  if (e instanceof Error) return e.message
  return '请求失败，请稍后重试'
}
