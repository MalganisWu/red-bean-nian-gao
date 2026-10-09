import { Client, type BucketItemStat, type ClientOptions } from 'minio'
import { z } from 'zod'

import type { ObjectStorage, PresignInput, UploadInput } from './port/object-storage.js'
import type { ObjectDownload, ObjectInfo } from '../application/model/object-result.js'
import { bindDownloadStreamToAbort } from './download-stream-lifecycle.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

const metadataSchema = z.record(z.string(), z.unknown())

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

  public async delete(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      await this.#client.removeObject(this.#bucket, key)
      signal.throwIfAborted()
    } catch (cause: unknown) {
      throw new Error(`delete ${JSON.stringify(key)} failed: ${message(cause)}`, { cause })
    }
  }

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
