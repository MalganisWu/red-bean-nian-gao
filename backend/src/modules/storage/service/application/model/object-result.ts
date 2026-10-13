import type { Readable } from 'node:stream'

/** Storage 应用层公开的稳定对象元数据，不包含 MinIO 协议类型。 */
export interface ObjectInfo {
  /** 对象在桶内的完整 key，已含 `uploads/{userId}/` 归属前缀。 */
  readonly key: string
  /** 对象字节数；下载响应据此回填 content-length。 */
  readonly size: number
  /** 对象内容类型；下载响应据此回填 content-type，缺省时为 `application/octet-stream`。 */
  readonly contentType: string
  /** 对象存储给出的 ETag；透传给下载响应，供客户端做条件请求与完整性判断。 */
  readonly etag: string
  /** 对象最后修改时间，用于缓存与过期判定；由底层适配器转换后给出。 */
  readonly lastModified: Date
}

/**
 * Storage 下载用例的流式结果；调用方取得结果后负责消费响应流，取消传播与底层释放由出站 Adapter 兜底。
 */
export interface ObjectDownload {
  /** 未消费的对象字节流；所有者是取得本结果的调用方，须负责消费，其释放由适配器兜底。 */
  readonly body: Readable
  /** 与流对应的对象元信息；用于回填响应头，不随流的消费而失效。 */
  readonly info: ObjectInfo
}
