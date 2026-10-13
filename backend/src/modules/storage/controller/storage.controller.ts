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

  /**
   * 上传对象并回吐其元信息。
   *
   * 失败语义集中在 `mapStorageFailure`：入参非法映射 400、对象不存在映射 404，其余未知异常落
   * 500（写日志保留 cause）。对象 key 由应用层生成，控制器不参与命名。
   *
   * @param command - 上传命令，含归属用户与文件内容；`userId` 来自 Principal，不接受请求体改写
   * @param signal - 请求生命周期绑定的取消信号，客户端断开时透传给应用层
   * @returns 对象元信息 DTO，可进成功信封
   */
  public async upload(command: UploadObjectCommand, signal: AbortSignal): Promise<ObjectInfoDto> {
    try {
      return toObjectInfoDto(await this.#storage.upload(command, signal))
    } catch (cause: unknown) {
      throw mapStorageFailure(cause, '上传失败')
    }
  }

  /**
   * 打开对象下载流并返回其元信息。
   *
   * 返回的 `body` 是**未消费**的流：所有权交给路由层写入 HTTP 响应，控制器不读取、不关闭；
   * 取消由传入的 signal 向下传播，底层 Adapter 负责销毁 MinIO 响应流。
   *
   * @param userId - 归属用户 ID，来自 Principal；用于拼接并校验对象 key 前缀
   * @param objectPath - 通配路径解析出的对象 key；越权 key 会被应用层判为不存在
   * @param signal - 请求生命周期绑定的取消信号，断连时透传到流生命周期
   * @returns 下载流与元信息；流由调用方负责消费
   */
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

  /**
   * 删除当前用户拥有的对象。
   *
   * 删除是幂等的：对象本就不存在时底层不报错，仍返回成功回执；失败按映射规则落 400/404/500。
   *
   * @param userId - 归属用户 ID，来自 Principal；决定可删除的 key 前缀
   * @param objectPath - 通配路径解析出的对象 key
   * @param signal - 请求生命周期绑定的取消信号
   * @returns 固定文案的删除回执
   */
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

  /**
   * 签发下载预签名 URL。
   *
   * 与 `presignPut` 共用 `#presign`：两者只在签名动作与失败文案上不同。URL 直接回给客户端，
   * 由客户端绕过后端访问对象存储。
   *
   * @param command - 预签名命令；`expiresSeconds` 缺省取默认有效期，超上限由应用层拒绝
   * @param signal - 请求生命周期绑定的取消信号
   * @returns URL 与本次实际采用的有效期（秒）
   */
  public presignGet(
    command: PresignObjectCommand,
    signal: AbortSignal
  ): Promise<{ readonly url: string; readonly expires_in: number }> {
    return this.#presign(command, signal, 'get')
  }

  /**
   * 签发上传预签名 URL。
   *
   * 与 `presignGet` 对称，共用 `#presign`；服务端只产出 URL，不在服务端创建对象，上传由客户端
   * 用该 URL 完成。
   *
   * @param command - 预签名命令；`expiresSeconds` 缺省取默认有效期，超上限由应用层拒绝
   * @param signal - 请求生命周期绑定的取消信号
   * @returns URL 与本次实际采用的有效期（秒）
   */
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
