import { posix } from 'node:path'
import { Readable } from 'node:stream'

import type { ObjectDownload, ObjectInfo } from './model/object-result.js'
import type { ObjectStorage, PresignInput } from '../object-storage/port/object-storage.js'
import {
  STORAGE_APPLICATION_ERROR_CODES,
  StorageApplicationError,
} from './error/storage-application-error.js'

export interface UploadObjectCommand {
  readonly userId: string
  readonly filename: string
  readonly contentType: string
  readonly contents: Buffer
}

export interface PresignObjectCommand {
  readonly userId: string
  readonly key: string
  readonly expiresSeconds?: number | undefined
}

export interface PresignObjectResult {
  readonly url: string
  readonly expiresSeconds: number
}

const DEFAULT_PRESIGN_SECONDS = 15 * 60
const MAX_PRESIGN_SECONDS = 60 * 60

/**
 * Storage 对象用例，内部 1:1 实现，无独立 Port；由 `storage.module.ts` 组装，
 * Controller 直接依赖本类。统一拥有对象 key、用户归属和预签名有效期规则。
 */
export class StorageService {
  readonly #storage: ObjectStorage
  readonly #now: () => Date

  public constructor(storage: ObjectStorage, now: () => Date = (): Date => new Date()) {
    this.#storage = storage
    this.#now = now
  }

  public upload(command: UploadObjectCommand, signal: AbortSignal): Promise<ObjectInfo> {
    const key = `uploads/${command.userId}/${String(this.#now().getTime())}${safeUploadExtension(command.filename)}`
    return this.#storage.upload(
      {
        key,
        body: Readable.from(command.contents),
        size: command.contents.length,
        contentType: command.contentType,
      },
      signal
    )
  }

  public async download(userId: string, key: string, signal: AbortSignal): Promise<ObjectDownload> {
    const ownedKey = ownedObjectKey(userId, key)
    // 先 stat 判定存在性再打开下载流：MinIO 对不存在的 key 在 getObject/statObject
    // 阶段抛 NoSuchKey，若不预检会冒泡成内部错误（500）；预检命中 undefined 时
    // 由 Controller 映射为 404「对象不存在」，与 delete/foreign-key 语义一致。
    if ((await this.#storage.stat(ownedKey, signal)) === undefined) {
      throw new StorageApplicationError(STORAGE_APPLICATION_ERROR_CODES.NOT_FOUND, '对象不存在')
    }
    return this.#storage.download(ownedKey, signal)
  }

  public delete(userId: string, key: string, signal: AbortSignal): Promise<void> {
    return this.#storage.delete(ownedObjectKey(userId, key), signal)
  }

  public presignGet(
    command: PresignObjectCommand,
    signal: AbortSignal
  ): Promise<PresignObjectResult> {
    return this.#presign(command, signal, 'get')
  }

  public presignPut(
    command: PresignObjectCommand,
    signal: AbortSignal
  ): Promise<PresignObjectResult> {
    return this.#presign(command, signal, 'put')
  }

  async #presign(
    command: PresignObjectCommand,
    signal: AbortSignal,
    kind: 'get' | 'put'
  ): Promise<PresignObjectResult> {
    const input: PresignInput = {
      key: ownedObjectKey(command.userId, command.key),
      expiresSeconds: presignExpiry(command.expiresSeconds),
    }
    const url =
      kind === 'get'
        ? await this.#storage.presignGet(input, signal)
        : await this.#storage.presignPut(input, signal)
    return { url, expiresSeconds: input.expiresSeconds }
  }
}

function safeUploadExtension(filename: string): string {
  const normalized = filename.replaceAll('\\', '/')
  const extension = posix.extname(posix.basename(normalized)).toLowerCase()
  return extension.length <= 16 && /^\.[a-z0-9]+$/u.test(extension) ? extension : ''
}

function ownedObjectKey(userId: string, rawKey: string): string {
  const key = rawKey.trim().replace(/^\/+/, '')
  if (key === '' || posix.normalize(key) !== key || key.includes('\\')) {
    throw new StorageApplicationError(
      STORAGE_APPLICATION_ERROR_CODES.INVALID_INPUT,
      '对象 key 非法'
    )
  }
  if (!key.startsWith(`uploads/${userId}/`)) {
    throw new StorageApplicationError(STORAGE_APPLICATION_ERROR_CODES.NOT_FOUND, '对象不存在')
  }
  return key
}

function presignExpiry(seconds: number | undefined): number {
  if (seconds === undefined || seconds <= 0) return DEFAULT_PRESIGN_SECONDS
  if (seconds > MAX_PRESIGN_SECONDS) {
    throw new StorageApplicationError(
      STORAGE_APPLICATION_ERROR_CODES.INVALID_INPUT,
      '预签名 URL 有效期不能超过 1 小时'
    )
  }
  return seconds
}
