/**
 * Identity Module 的密码散列与校验边界。
 * 默认实现为 `BcryptPasswordHasher`，由 `identity.module.ts` 创建并注入注册与认证用例；明文密码不得离开本边界持久化。
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(hashedPassword: string, plainPassword: string): Promise<void>
}
