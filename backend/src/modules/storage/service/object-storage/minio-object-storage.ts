import { Client, type BucketItemStat, type ClientOptions } from 'minio'
import { z } from 'zod'

import type { ObjectStorage, PresignInput, UploadInput } from './port/object-storage.js'
import type { ObjectDownload, ObjectInfo } from '../application/model/object-result.js'
import { bindDownloadStreamToAbort } from './download-stream-lifecycle.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

const metadataSchema = z.record(z.string(), z.unknown())

/** MinIO 连接配置；由 `config.minio` 段映射而来，字段与配置层一一对应。 */
export interface MinioStorageConfig {
  readonly endpoint: string
  readonly accessKey: string
  readonly secretKey: string
  readonly bucket: string
  readonly useSsl: boolean
  readonly region: string
}

/**
 * Storage Module 的 MinIO 出站 Adapter，由 `storage.module.ts` 绑定到 `ObjectStorage`。
 * 调用失败保留 cause 向上交给应用错误边界；下载流与请求取消的资源释放由本 Adapter 负责。
 */
export class MinioObjectStorage implements ObjectStorage {
  readonly #client: Client
  readonly #bucket: string
  readonly #region: string

  public constructor(config: MinioStorageConfig) {
    if (config.bucket.trim() === '') throw new Error('MinIO bucket must not be empty')
    this.#client = new Client(clientOptions(config))
    this.#bucket = config.bucket
    this.#region = config.region
  }

  /**
   * 确保目标 bucket 存在，不存在则创建。
   *
   * 只在启动期调用一次；创建时按配置决定是否带 region。任何失败都包装后重抛并保留 cause，
   * 让启动期失败直接拒绝启动，而不是带着不可用的存储降级运行。
   *
   * @param signal - 启动期取消信号；创建前后各检查一次，避免带着已取消的上下文继续
   */
  public async ensureBucket(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      if (!(await this.#client.bucketExists(this.#bucket))) {
        if (this.#region === '') await this.#client.makeBucket(this.#bucket)
        else await this.#client.makeBucket(this.#bucket, this.#region)
      }
      signal.throwIfAborted()
    } catch (cause: unknown) {
      throw new Error(
        `failed to ensure bucket ${JSON.stringify(this.#bucket)}: ${message(cause)}`,
        {
          cause,
        }
      )
    }
  }

  /**
   * 上传对象到 bucket。
   *
   * 传入的 `body` 会被 `putObject` 完整消费，流的消费与销毁责任在本方法内即告结束；成功后再
   * stat 回读元信息，保证返回的 size/etag 来自服务端而非本地推断。`putObject` 成功即对象完整，
   * 失败不会留下半成品对象。
   *
   * @param input - 待写入对象的 key、内容流、大小与 MIME 类型；key 由应用层生成
   * @param signal - 请求生命周期绑定的取消信号；上传前后各检查一次
   * @returns 服务端确认后的对象元信息
   */
  public async upload(input: UploadInput, signal: AbortSignal): Promise<ObjectInfo> {
    signal.throwIfAborted()
    try {
      await this.#client.putObject(this.#bucket, input.key, input.body, input.size, {
        'Content-Type': input.contentType,
      })
      signal.throwIfAborted()
      return objectInfo(input.key, await this.#client.statObject(this.#bucket, input.key))
    } catch (cause: unknown) {
      throw new Error(`upload ${JSON.stringify(input.key)} failed: ${message(cause)}`, { cause })
    }
  }

  /**
   * 打开对象下载流。
   *
   * 返回的 `body` 是未消费的流，所有权交给调用方；本适配器只负责把它与请求取消绑定（见
   * `bindDownloadStreamToAbort`）。打开或 stat 失败时会主动 `destroy` 已开的流，避免留下
   * 半开的 MinIO 连接。
   *
   * @param key - 对象 key；不存在时底层抛 NoSuchKey，这里包装后重抛
   * @param signal - 请求生命周期绑定的取消信号，取消时销毁下载流
   * @returns 下载流与对象元信息；流由调用方负责消费
   */
  public async download(key: string, signal: AbortSignal): Promise<ObjectDownload> {
    signal.throwIfAborted()
    let body: Awaited<ReturnType<Client['getObject']>> | undefined
    try {
      body = await this.#client.getObject(this.#bucket, key)
      bindDownloadStreamToAbort(body, signal)
      const info = objectInfo(key, await this.#client.statObject(this.#bucket, key))
      signal.throwIfAborted()
      return { body, info }
    } catch (cause: unknown) {
      body?.destroy()
      throw new Error(`download ${JSON.stringify(key)} failed: ${message(cause)}`, { cause })
    }
  }

  /**
   * 删除对象。
   *
   * 对不存在的 key 不报错（MinIO 语义即幂等），调用方因此可以安全重试。
   *
   * @param key - 要删除的对象 key
   * @param signal - 请求生命周期绑定的取消信号，删除前后各检查一次
   */
  public async delete(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      await this.#client.removeObject(this.#bucket, key)
      signal.throwIfAborted()
    } catch (cause: unknown) {
      throw new Error(`delete ${JSON.stringify(key)} failed: ${message(cause)}`, { cause })
    }
  }

  /**
   * 读取对象元信息，用于存在性预检。
   *
   * `NoSuchKey` 与 `NotFound` 两种「不存在」被归一成 `undefined` 而非抛错，把「不存在」与
   * 「访问失败」区分开；其余错误包装后重抛，避免把故障误判成对象缺失。
   *
   * @param key - 要探测的对象 key
   * @param signal - 请求生命周期绑定的取消信号，查询前后各检查一次
   * @returns 对象元信息；对象不存在时返回 `undefined`
   */
  public async stat(key: string, signal: AbortSignal): Promise<ObjectInfo | undefined> {
    signal.throwIfAborted()
    try {
      const stat = await this.#client.statObject(this.#bucket, key)
      signal.throwIfAborted()
      return objectInfo(key, stat)
    } catch (cause: unknown) {
      if (hasErrorCode(cause, 'NoSuchKey') || hasErrorCode(cause, 'NotFound')) return undefined
      throw new Error(`stat ${JSON.stringify(key)} failed: ${message(cause)}`, { cause })
    }
  }

  /**
   * 签发下载预签名 URL。
   *
   * 只做签名，不校验对象是否存在（MinIO 预签名不看存在性）；客户端拿着 URL 直连存储，有效期
   * 因此由应用层夹取后传入。失败包装后重抛。
   *
   * @param input - 对象 key 与有效期（秒）
   * @param signal - 请求生命周期绑定的取消信号，签名前后各检查一次
   * @returns 预签名下载 URL
   */
  public async presignGet(input: PresignInput, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    try {
      const url = await this.#client.presignedGetObject(
        this.#bucket,
        input.key,
        input.expiresSeconds
      )
      signal.throwIfAborted()
      return url
    } catch (cause: unknown) {
      throw new Error(`presign get ${JSON.stringify(input.key)} failed: ${message(cause)}`, {
        cause,
      })
    }
  }

  /**
   * 签发上传预签名 URL。
   *
   * 与 `presignGet` 对称，只做签名；服务端不创建对象，实际上传由客户端用该 URL 完成。
   *
   * @param input - 对象 key 与有效期（秒）
   * @param signal - 请求生命周期绑定的取消信号，签名前后各检查一次
   * @returns 预签名上传 URL
   */
  public async presignPut(input: PresignInput, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    try {
      const url = await this.#client.presignedPutObject(
        this.#bucket,
        input.key,
        input.expiresSeconds
      )
      signal.throwIfAborted()
      return url
    } catch (cause: unknown) {
      throw new Error(`presign put ${JSON.stringify(input.key)} failed: ${message(cause)}`, {
        cause,
      })
    }
  }
}

function clientOptions(config: MinioStorageConfig): ClientOptions {
  const endpoint = new URL(`${config.useSsl ? 'https' : 'http'}://${config.endpoint}`)
  if (endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('MinIO endpoint must contain only host and optional port')
  }
  const port = endpoint.port === '' ? undefined : Number(endpoint.port)
  if (port !== undefined && (!Number.isSafeInteger(port) || port <= 0)) {
    throw new Error('MinIO endpoint port is invalid')
  }
  return {
    endPoint: endpoint.hostname,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    useSSL: config.useSsl,
    ...optionalField('port', port),
    ...(config.region === '' ? {} : { region: config.region }),
  }
}

function objectInfo(key: string, stat: BucketItemStat): ObjectInfo {
  const metadata = metadataSchema.safeParse(stat.metaData)
  const contentTypeValue = metadata.success
    ? (metadata.data['content-type'] ?? metadata.data['Content-Type'])
    : undefined
  return {
    key,
    size: stat.size,
    contentType:
      typeof contentTypeValue === 'string' ? contentTypeValue : 'application/octet-stream',
    etag: stat.etag,
    lastModified: stat.lastModified,
  }
}

function hasErrorCode(value: unknown, expected: string): boolean {
  return value instanceof Error && 'code' in value && value.code === expected
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
