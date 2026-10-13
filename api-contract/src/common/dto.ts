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
  /** 业务码；成功响应的取值由契约固定，供前端按键分支。 */
  readonly code: number
  /** 接口的业务数据；形状由各接口的 DTO 决定。 */
  readonly data: TData
}

/** 业务接口统一错误信封。 */
export interface ApiErrorDto {
  /** 业务错误码，取值来自 `API_ERROR_CODES`；前端据此分支。 */
  readonly code: number
  /** 已本地化的错误文案；可直接展示给用户。 */
  readonly message: string
  /** 恒为 null：错误响应不带业务数据，占位以保持与成功信封同形。 */
  readonly data: null
}
