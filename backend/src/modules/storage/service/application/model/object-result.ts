import type { Readable } from 'node:stream'

/** Storage 应用层公开的稳定对象元数据，不包含 MinIO 协议类型。 */
export interface ObjectInfo {
  readonly key: string
  readonly size: number
  readonly contentType: string
  readonly etag: string
  readonly lastModified: Date
}

/**
 * Storage 下载用例的流式结果；调用方取得结果后负责消费响应流，取消传播与底层释放由出站 Adapter 兜底。
 */
export interface ObjectDownload {
  readonly body: Readable
  readonly info: ObjectInfo
}
