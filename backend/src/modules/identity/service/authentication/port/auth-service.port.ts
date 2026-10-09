import type { TokenValidator } from '../../../../../shared/authentication/token-validator.js'

/**
 * HTTP Controller 使用的认证能力入口。
 * 默认实现为 `JwtAuthService`，由 `identity.module.ts` 完成组装，再由全局 composition root 注入其他 Module。
 * 显式扩展共享 `TokenValidator`，保证 HTTP PreHandler 的默认绑定不是依靠结构类型巧合成立。
 */
export interface AuthServicePort extends TokenValidator {
  login(username: string, password: string, signal: AbortSignal): Promise<string>
  logout(token: string, signal: AbortSignal): Promise<void>
  validateToken(token: string, signal: AbortSignal): Promise<string>
  refreshToken(oldToken: string, signal: AbortSignal): Promise<string>
}
