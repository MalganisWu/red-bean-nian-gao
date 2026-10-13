/** 跨 Module 使用的不透明产品 ID 生成能力；生产实现由全局 Composition Root 注入。 */
export interface IdGenerator {
  /**
   * 生成一个带前缀的不透明产品 ID。
   * @param prefix - 产品语义前缀（如 `REQ`），用于在日志与排障中一眼区分 ID 来源。
   * @returns 生成的产品 ID 字符串。
   */
  generate(prefix: string): string
}
