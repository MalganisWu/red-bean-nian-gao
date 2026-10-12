/** 前后端共享的 JSON 值定义。 */
export type JsonPrimitive = boolean | number | string | null
/** 可 JSON 序列化的值；用于跨边界的自由结构，消费方仍需自行校验具体形状。 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
/** JSON 对象形式；索引签名只接受 `JsonValue`，不可序列化的值因此进不来。 */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** 业务接口统一成功信封。 */
export interface ApiEnvelope<TData> {
  readonly code: number
  readonly data: TData
}

/** 业务接口统一错误信封。 */
export interface ApiErrorDto {
  readonly code: number
  readonly message: string
  readonly data: null
}
