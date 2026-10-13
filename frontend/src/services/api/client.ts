import { API_ROUTES } from '@red-bean/api-contract'
import { useAuthStore } from '@/stores/auth-store'
import { isTokenExpiringSoon } from '@/lib/token'
import { AppError, parseApiError } from '@/lib/errors'
import { decodeRefreshToken } from './response-validation'

type ResponseDecoder<TValue> = (value: unknown) => TValue

async function readJson(response: Response): Promise<unknown> {
  const source = await response.text()
  if (!source) return null
  return JSON.parse(source)
}

/**
 * 带 auth 拦截的 HTTP 客户端
 *
 * 统一处理传输层关注点：令牌临近过期时先自动刷新、注入 Bearer 与 JSON Content-Type、401 清空会话、
 * 非 2xx 把响应体转成 AppError 后抛出。返回前把原始响应体交给 `decode` 做运行时校验，
 * 把不可信的 `unknown` 收窄为调用方声明的可信类型。
 *
 * @param path - 经 API_ROUTES 拼出的完整路径；调用方不得手写路径字面量。
 * @param options - fetch 选项；未显式指定 Content-Type 且带非 FormData body 时自动补 application/json。
 * @param decode - 响应体校验/解包器；负责把未知响应收窄为 TValue，形状不符时应抛错。
 * @returns 校验通过后的响应数据。
 */
export async function apiCall<TValue>(
  path: string,
  options: RequestInit,
  decode: ResponseDecoder<TValue>
): Promise<TValue> {
  const { token, setToken, clearAuth } = useAuthStore.getState()

  // token 即将过期时自动刷新
  if (token && isTokenExpiringSoon(token)) {
    try {
      const res = await fetch(API_ROUTES.REFRESH.path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const refreshedToken = decodeRefreshToken(await readJson(res))
        if (refreshedToken) setToken(refreshedToken)
      } else {
        clearAuth()
      }
    } catch {
      // 刷新失败则沿用当前 token 继续请求
    }
  }

  const currentToken = useAuthStore.getState().token
  const headers = new Headers(options.headers)
  if (
    options.body !== undefined &&
    !headers.has('Content-Type') &&
    !(options.body instanceof FormData)
  ) {
    headers.set('Content-Type', 'application/json')
  }
  if (currentToken) {
    headers.set('Authorization', `Bearer ${currentToken}`)
  }

  const response = await fetch(path, { ...options, headers })

  if (response.status === 401) {
    // 清空会话后由 RequireAuth 响应式重定向到登录页；不做整页跳转，保留 SPA 内存状态
    useAuthStore.getState().clearAuth()
    throw new AppError('登录已过期，请重新登录', 401, 4002)
  }

  if (!response.ok) {
    const body = await readJson(response).catch(() => null)
    const { message, code } = parseApiError(body)
    throw new AppError(message, response.status, code)
  }

  return decode(await readJson(response))
}
