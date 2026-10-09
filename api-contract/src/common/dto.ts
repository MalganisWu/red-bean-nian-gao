/** 前后端共享的 JSON 值定义。 */
export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
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
