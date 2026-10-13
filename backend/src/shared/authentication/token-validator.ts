/**
 * HTTP 认证机制所需的最小 Token 验证边界。
 *
 * Identity Module 的 `AuthServicePort` 显式扩展本接口；共享 HTTP PreHandler 只依赖这里，不反向依赖
 * Identity 的登录、登出与刷新能力。
 */
export interface TokenValidator {
  /**
   * 校验 Bearer token 并解析出用户 ID；失败的区分度由实现决定，调用方统一映射为 401。
   * @param token - 已剥掉 `Bearer ` 前缀的原始 token 串。
   * @param signal - 请求级取消信号；请求断连时据此中断校验。
   * @returns 校验通过时为用户 ID；约定用空串表示校验未通过。
   */
  validateToken(token: string, signal: AbortSignal): Promise<string>
}
