import type { Readable } from 'node:stream'
import type { ObjectDownload, ObjectInfo } from '../../application/model/object-result.js'

/** 上传入参；`size` 必须由调用方给出——对象存储要先知道读多少字节，流本身不携带长度。 */
export interface UploadInput {
  /** 对象键；由应用层生成，已含归属前缀，Adapter 不参与命名。 */
  readonly key: string
  /** 对象内容流；所有权在调用 `upload` 后转移给 Adapter，由它完整消费并销毁。 */
  readonly body: Readable
  /** 内容字节数；必须由调用方给出，因为流本身不携带长度。 */
  readonly size: number
  /** 内容 MIME 类型；作为对象元数据写入，缺省时由上游回退为 `application/octet-stream`。 */
  readonly contentType: string
}

/** 预签名入参：对象键与链接有效期（秒）。 */
export interface PresignInput {
  /** 对象键；由应用层补全归属前缀后传入。 */
  readonly key: string
  /** 链接有效期（秒）；由应用层夹取后再传入，Adapter 不再校验。 */
  readonly expiresSeconds: number
}

/**
 * Storage Module 访问对象存储的出站 Port。
 * 默认实现为 `MinioObjectStorage`，由 `storage.module.ts` 创建；调用方拥有返回的下载流，
 * HTTP 层取消请求后必须停止消费，Adapter 会销毁底层响应流；连接、权限与协议失败原样向应用层传播。
 * Port 不转移客户端所有权，MinIO 客户端生命周期仍由 Storage Module 管理。
 */
export interface ObjectStorage {
  /**
   * 确保目标 bucket 存在，不存在则创建。
   *
   * 供启动期调用；失败即视为存储不可用并向上抛出，不带降级运行，避免后续请求接连失败。
   *
   * @param signal - 启动期取消信号；取消时中止就绪检查
   */
  ensureBucket(signal: AbortSignal): Promise<void>
  /**
   * 上传对象。
   *
   * 调用方传入的 `body` 所有权在此转移，由实现完整消费并负责销毁；成功即对象完整，失败不留下
   * 半成品对象。
   *
   * @param input - 对象键、内容流、字节数与 MIME 类型
   * @param signal - 请求生命周期绑定的取消信号；取消时中止上传并销毁流
   * @returns 服务端确认后的对象元信息
   */
  upload(input: UploadInput, signal: AbortSignal): Promise<ObjectInfo>
  /**
   * 打开对象下载流。
   *
   * 返回的流是未消费的，所有权交给调用方；取消后实现须销毁底层响应流，调用方无需再自行释放。
   *
   * @param key - 对象键；不存在时实现应抛错而非返回空流
   * @param signal - 请求生命周期绑定的取消信号；取消时销毁下载流
   * @returns 未消费的下载流与对象元信息
   */
  download(key: string, signal: AbortSignal): Promise<ObjectDownload>
  /**
   * 删除对象。
   *
   * 对象不存在不应视为失败（幂等），调用方可安全重试。
   *
   * @param key - 要删除的对象键
   * @param signal - 请求生命周期绑定的取消信号
   */
  delete(key: string, signal: AbortSignal): Promise<void>
  /**
   * 读取对象元信息，用于存在性预检。
   *
   * 「对象不存在」与「访问失败」必须区分开：前者返回 `undefined`，后者抛错，避免把故障误判成缺失。
   *
   * @param key - 要探测的对象键
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 对象元信息；对象不存在时为 `undefined`
   */
  stat(key: string, signal: AbortSignal): Promise<ObjectInfo | undefined>
  /**
   * 签发下载预签名 URL。
   *
   * 只做签名，不校验对象是否存在；URL 交客户端直连对象存储，服务端不代理字节。
   *
   * @param input - 对象键与有效期（秒）
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 预签名下载 URL
   */
  presignGet(input: PresignInput, signal: AbortSignal): Promise<string>
  /**
   * 签发上传预签名 URL。
   *
   * 与 `presignGet` 对称，只做签名；服务端不创建对象，实际上传由客户端用该 URL 完成。
   *
   * @param input - 对象键与有效期（秒）
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 预签名上传 URL
   */
  presignPut(input: PresignInput, signal: AbortSignal): Promise<string>
}
