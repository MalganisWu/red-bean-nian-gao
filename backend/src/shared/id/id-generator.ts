/** 跨 Module 使用的不透明产品 ID 生成能力；生产实现由全局 Composition Root 注入。 */
export interface IdGenerator {
  generate(prefix: string): string
}
