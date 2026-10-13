/**
 * Identity Module 的密码散列与校验边界。
 * 默认实现为 `BcryptPasswordHasher`，由 `identity.module.ts` 创建并注入注册与认证用例；明文密码不得离开本边界持久化。
 */
export interface PasswordHasher {
  /**
   * 计算密码散列。
   *
   * 明文只在调用栈内存在；失败时上抛且错误信息不得包含明文。
   *
   * @param password - 待散列的明文密码
   * @returns 可直接入库的散列串，已含算法参数与盐
   */
  hash(password: string): Promise<string>
  /**
   * 校验明文密码与散列是否匹配。
   *
   * 不匹配即抛错，且实现不应细分失败原因（散列非法与口令不符都应归为同一错误），
   * 以免成为口令探测的旁路。
   *
   * @param hashedPassword - 库中存储的散列串
   * @param plainPassword - 待校验的明文密码，仅在调用栈内存在
   */
  verify(hashedPassword: string, plainPassword: string): Promise<void>
}
