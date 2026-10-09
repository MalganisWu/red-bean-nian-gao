/** JWT payload 解码（客户端不做验证，仅读取 claims） */
export function decodeJwtPayload(token: string): {
  user_id: string
  username: string
  exp: number
  iat: number
} | null {
  try {
    const base64Url = token.split('.')[1]
    if (!base64Url) return null
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    const payload: unknown = JSON.parse(jsonPayload)
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('user_id' in payload) ||
      typeof payload.user_id !== 'string' ||
      !('username' in payload) ||
      typeof payload.username !== 'string' ||
      !('exp' in payload) ||
      typeof payload.exp !== 'number' ||
      !('iat' in payload) ||
      typeof payload.iat !== 'number'
    ) {
      return null
    }
    return {
      user_id: payload.user_id,
      username: payload.username,
      exp: payload.exp,
      iat: payload.iat,
    }
  } catch {
    return null
  }
}

/** 检查 token 是否即将过期（默认 5 分钟阈值） */
export function isTokenExpiringSoon(token: string, thresholdMinutes = 5): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload) return true
  const expiresAt = payload.exp * 1000
  const threshold = thresholdMinutes * 60 * 1000
  return Date.now() > expiresAt - threshold
}

/** 检查 token 是否已过期 */
export function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload) return true
  return Date.now() > payload.exp * 1000
}
