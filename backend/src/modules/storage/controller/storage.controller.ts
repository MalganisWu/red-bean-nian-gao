import type { ObjectInfoDto } from './storage.dto.js'

import type { ObjectDownload } from '../service/application/model/object-result.js'
import type {
  PresignObjectCommand,
  PresignObjectResult,
  StorageService,
  UploadObjectCommand,
} from '../service/application/storage-service.js'
import {
  STORAGE_APPLICATION_ERROR_CODES,
  StorageApplicationError,
} from '../service/application/error/storage-application-error.js'
import {
  loggedInternalError,
  notFoundError,
  validationError,
} from '../../../shared/http/error-mapper.js'
import { toObjectInfoDto } from './storage-presenter.js'

/**
 * Storage 的 HTTP 用例控制器：方法签名即"入参 + 返回"，不接触 Fastify 类型；负责 DTO 投影与应用错误映射。
 * 请求解包（含 multipart）、Principal 传递、流响应投影与成功信封输出由 `storage.routes.ts` 承担。
 * 下载流的所有权说明：Controller 返回流式结果，路由层负责消费响应流；请求断连产生的 AbortSignal
 * 继续传入应用层，底层 Adapter 负责销毁 MinIO 响应流。
 */
export class StorageController {
  readonly #storage: StorageService

  public constructor(storage: StorageService) {
    this.#storage = storage
  }

  public async upload(command: UploadObjectCommand, signal: AbortSignal): Promise<ObjectInfoDto> {
    try {
      return toObjectInfoDto(await this.#storage.upload(command, signal))
    } catch (cause: unknown) {
      throw mapStorageFailure(cause, '上传失败')
    }
  }

  public async download(
    userId: string,
    objectPath: string,
    signal: AbortSignal
  ): Promise<ObjectDownload> {
    try {
      return await this.#storage.download(userId, objectPath, signal)
    } catch (cause: unknown) {
      throw mapStorageFailure(cause, '下载失败')
    }
  }

  public async delete(
    userId: string,
    objectPath: string,
    signal: AbortSignal
  ): Promise<{ readonly message: string }> {
    try {
      await this.#storage.delete(userId, objectPath, signal)
    } catch (cause: unknown) {
      throw mapStorageFailure(cause, '删除对象失败')
    }
    return { message: '已删除' }
  }

  public presignGet(
    command: PresignObjectCommand,
    signal: AbortSignal
  ): Promise<{ readonly url: string; readonly expires_in: number }> {
    return this.#presign(command, signal, 'get')
  }

  public presignPut(
    command: PresignObjectCommand,
    signal: AbortSignal
  ): Promise<{ readonly url: string; readonly expires_in: number }> {
    return this.#presign(command, signal, 'put')
  }

  async #presign(
    command: PresignObjectCommand,
    signal: AbortSignal,
    kind: 'get' | 'put'
  ): Promise<{ readonly url: string; readonly expires_in: number }> {
    try {
      const result: PresignObjectResult =
        kind === 'get'
          ? await this.#storage.presignGet(command, signal)
          : await this.#storage.presignPut(command, signal)
      return { url: result.url, expires_in: result.expiresSeconds }
    } catch (cause: unknown) {
      throw mapStorageFailure(cause, kind === 'get' ? '生成下载 URL 失败' : '生成上传 URL 失败')
    }
  }
}

function mapStorageFailure(cause: unknown, fallback: string): Error {
  if (cause instanceof StorageApplicationError) {
    if (cause.code === STORAGE_APPLICATION_ERROR_CODES.INVALID_INPUT) {
      return validationError(cause.message)
    }
    if (cause.code === STORAGE_APPLICATION_ERROR_CODES.NOT_FOUND) {
      return notFoundError(cause.message)
    }
  }
  return loggedInternalError(fallback, cause)
}
