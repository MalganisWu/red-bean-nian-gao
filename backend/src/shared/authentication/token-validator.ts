/**
 * HTTP 认证机制所需的最小 Token 验证边界。
 *
 * Identity Module 的 `AuthServicePort` 显式扩展本接口；共享 HTTP PreHandler 只依赖这里，不反向依赖
 * Identity 的登录、登出与刷新能力。
 */
export interface TokenValidator {
  validateToken(token: string, signal: AbortSignal): Promise<string>
}
