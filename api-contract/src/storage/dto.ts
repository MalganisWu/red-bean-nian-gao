/** 对象元信息；`etag` 可用于判断内容是否发生变化。 */
export interface ObjectInfoDto {
  /** 对象在存储桶内的 key，可含斜杠以表达目录层级。 */
  readonly key: string
  /** 对象字节数。 */
  readonly size: number
  /** 对象的 MIME 类型，如 `image/png`。 */
  readonly content_type: string
  /** 内容指纹；内容未变时取值不变，可用于判断对象是否更新。 */
  readonly etag: string
}

/** 预签名请求体；`expires` 是有效期秒数，缺省时由服务端取默认值。 */
export interface PresignRequestDto {
  /** 要生成的预签名 URL 对应的对象 key。 */
  readonly key: string
  /** 有效期秒数；缺省时由服务端取默认值。 */
  readonly expires?: number | undefined
}
