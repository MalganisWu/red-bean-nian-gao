/** 对象元信息；`etag` 可用于判断内容是否发生变化。 */
export interface ObjectInfoDto {
  readonly key: string
  readonly size: number
  readonly content_type: string
  readonly etag: string
}

/** 预签名请求体；`expires` 是有效期秒数，缺省时由服务端取默认值。 */
export interface PresignRequestDto {
  readonly key: string
  readonly expires?: number | undefined
}
