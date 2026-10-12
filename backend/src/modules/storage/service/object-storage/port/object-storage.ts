import type { Readable } from 'node:stream'
import type { ObjectDownload, ObjectInfo } from '../../application/model/object-result.js'

/** 上传入参；`size` 必须由调用方给出——对象存储要先知道读多少字节，流本身不携带长度。 */
export interface UploadInput {
  readonly key: string
  readonly body: Readable
  readonly size: number
  readonly contentType: string
}

/** 预签名入参：对象键与链接有效期（秒）。 */
export interface PresignInput {
  readonly key: string
  readonly expiresSeconds: number
}

/**
 * Storage Module 访问对象存储的出站 Port。
 * 默认实现为 `MinioObjectStorage`，由 `storage.module.ts` 创建；调用方拥有返回的下载流，
 * HTTP 层取消请求后必须停止消费，Adapter 会销毁底层响应流；连接、权限与协议失败原样向应用层传播。
 * Port 不转移客户端所有权，MinIO 客户端生命周期仍由 Storage Module 管理。
 */
export interface ObjectStorage {
  ensureBucket(signal: AbortSignal): Promise<void>
  upload(input: UploadInput, signal: AbortSignal): Promise<ObjectInfo>
  download(key: string, signal: AbortSignal): Promise<ObjectDownload>
  delete(key: string, signal: AbortSignal): Promise<void>
  stat(key: string, signal: AbortSignal): Promise<ObjectInfo | undefined>
  presignGet(input: PresignInput, signal: AbortSignal): Promise<string>
  presignPut(input: PresignInput, signal: AbortSignal): Promise<string>
}
