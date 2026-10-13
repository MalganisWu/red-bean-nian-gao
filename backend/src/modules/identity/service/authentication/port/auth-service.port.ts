import type { TokenValidator } from '../../../../../shared/authentication/token-validator.js'

/**
 * HTTP Controller 使用的认证能力入口。
 * 默认实现为 `JwtAuthService`，由 `identity.module.ts` 完成组装，再由全局 composition root 注入其他 Module。
 * 显式扩展共享 `TokenValidator`，保证 HTTP PreHandler 的默认绑定不是依靠结构类型巧合成立。
 */
export interface AuthServicePort extends TokenValidator {
  /**
   * 校验凭据并签发访问令牌。
   *
   * 账号不存在、口令不匹配、账号停用等失败原因不应泄漏给调用方，实现须收敛为稳定的认证错误，
   * 由上层统一映射 401，避免成为账号枚举的旁路。
   *
   * @param username - 登录用户名，明文
   * @param password - 明文密码，仅在调用栈内存在，不得持久化或记录
   * @param signal - 请求生命周期绑定的取消信号，透传给底层查询
   * @returns 签名后的访问令牌原文字符串
   */
  login(username: string, password: string, signal: AbortSignal): Promise<string>
  /**
   * 注销令牌，使对应会话失效。
   *
   * 无状态 JWT 下实现可能无法真正撤销，契约只保证「尽力而为」；失败应作为服务端错误上抛，
   * 不应误导调用方去重新登录。
   *
   * @param token - 待注销的令牌原文
   * @param signal - 请求生命周期绑定的取消信号
   */
  logout(token: string, signal: AbortSignal): Promise<void>
  /**
   * 校验令牌签名与有效期，返回其声明的用户 ID。
   *
   * 令牌无效、过期等失败须抛稳定的认证错误，供上层区分处理（如引导重新登录）。
   *
   * @param token - 待校验的令牌原文，通常来自 Authorization 头
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 令牌中经校验的用户 ID
   */
  validateToken(token: string, signal: AbortSignal): Promise<string>
  /**
   * 用旧令牌换取新令牌，延长会话。
   *
   * 是否接受已过期的旧令牌由实现决定；无论哪种策略，签名必须有效，且用户须仍然存在且启用。
   *
   * @param oldToken - 待续签的旧令牌原文
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 重新签发的访问令牌原文字符串
   */
  refreshToken(oldToken: string, signal: AbortSignal): Promise<string>
}
