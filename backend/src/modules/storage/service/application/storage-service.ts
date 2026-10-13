import { posix } from 'node:path'
import { Readable } from 'node:stream'

import type { ObjectDownload, ObjectInfo } from './model/object-result.js'
import type { ObjectStorage, PresignInput } from '../object-storage/port/object-storage.js'
import {
  STORAGE_APPLICATION_ERROR_CODES,
  StorageApplicationError,
} from './error/storage-application-error.js'

/** 上传命令；对象 key 由本服务按 `uploads/{userId}/{时间戳}{扩展名}` 生成，调用方不参与命名。 */
export interface UploadObjectCommand {
  /** 归属用户 ID；决定对象 key 前缀，只应来自 Principal，不接受请求体改写。 */
  readonly userId: string
  /** 原始文件名；只用于推断扩展名，不进入 key 的主体部分。 */
  readonly filename: string
  /** 客户端声明的内容类型；缺失时上游已回退为 `application/octet-stream`。 */
  readonly contentType: string
  /** 文件字节内容；传输层已按大小上限校验，在此转为只读流交给适配器。 */
  readonly contents: Buffer
}

/** 预签名命令；`expiresSeconds` 缺省取 15 分钟，超过 1 小时会被拒。 */
export interface PresignObjectCommand {
  /** 归属用户 ID；决定对象 key 前缀，越权 key 会被判为不存在。 */
  readonly userId: string
  /** 待签名的对象 key；本服务会先补上归属前缀并校验。 */
  readonly key: string
  /** 期望的有效期（秒）；缺省取 15 分钟，超过 1 小时直接拒绝。 */
  readonly expiresSeconds?: number | undefined
}

/** 预签名结果；`expiresSeconds` 回传实际采用的有效期，可能与请求值不同。 */
export interface PresignObjectResult {
  /** 可直接交给客户端使用的预签名 URL，含签名与有效期。 */
  readonly url: string
  /** 本次实际采用的有效期（秒）；回传真实值，避免调用方按请求值误算过期时间。 */
  readonly expiresSeconds: number
}

/** 预签名 URL 的默认有效期，15 分钟；未指定或非正数时采用。 */
const DEFAULT_PRESIGN_SECONDS = 15 * 60
/** 预签名 URL 的有效期上限，1 小时；超过即拒绝，避免签发长期可用的外链。 */
const MAX_PRESIGN_SECONDS = 60 * 60

/**
 * Storage 对象用例，内部 1:1 实现，无独立 Port；由 `storage.module.ts` 组装，
 * Controller 直接依赖本类。统一拥有对象 key、用户归属和预签名有效期规则。
 */
export class StorageService {
  /** 对象存储适配器，构造时注入；对象读写与预签名都由它执行。 */
  readonly #storage: ObjectStorage
  /**
   * 生成对象 key 中时间戳的时钟，构造时确定；默认取系统时钟，测试可注入固定实现。
   * @returns 当前时刻
   */
  readonly #now: () => Date

  public constructor(storage: ObjectStorage, now: () => Date = (): Date => new Date()) {
    this.#storage = storage
    this.#now = now
  }

  /**
   * 上传对象，key 由本服务生成。
   *
   * 命名规则固定为 `uploads/{userId}/{时间戳}{扩展名}`：调用方不参与命名，从根上杜绝越权写入
   * 他人前缀；扩展名经白名单化（仅短小写字母数字），拿不到就整体省略。内容包成只读流交给
   * Adapter，流的消费与销毁责任随之转移。
   *
   * @param command - 上传命令；`userId` 决定 key 前缀，`contents` 以 Buffer 传入、在此转为流
   * @param signal - 请求生命周期绑定的取消信号，透传给底层 Adapter
   * @returns 写入对象的元信息
   */
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

  /**
   * 打开对象下载流。
   *
   * 先 `stat` 判定存在性再打开流：MinIO 对不存在的 key 在打开阶段抛错，若不预检会冒泡成 500；
   * 预检命中 `undefined` 时抛 NOT_FOUND，由 Controller 映射 404，与 delete 的语义一致。key 先
   * 经归属校验，越权 key 与不存在同样收敛为 404，不泄漏他人对象是否存在。
   *
   * @param userId - 归属用户 ID；必须是 key 前缀 `uploads/{userId}/` 的持有者
   * @param key - 请求指定的对象 key；越权或非法一律按不存在或非法入参拒绝
   * @param signal - 请求生命周期绑定的取消信号，透传到流的生命周期
   * @returns 下载流与元信息；流的所有权交给调用方消费
   */
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

  /**
   * 删除对象。
   *
   * key 先经归属校验再交给底层；底层删除对不存在的对象是幂等的，因此重复删除不报错。
   *
   * @param userId - 归属用户 ID，决定可删除的 key 前缀
   * @param key - 请求指定的对象 key；越权 key 按不存在拒绝
   * @param signal - 请求生命周期绑定的取消信号，透传给底层 Adapter
   */
  public delete(userId: string, key: string, signal: AbortSignal): Promise<void> {
    return this.#storage.delete(ownedObjectKey(userId, key), signal)
  }

  /**
   * 签发下载预签名 URL。
   *
   * 与 `presignPut` 共用 `#presign`：归属校验与有效期夹取都在其中完成，两个入口只在签名动作上
   * 不同。签发的 URL 交给客户端直连对象存储，服务端不代理字节。
   *
   * @param command - 预签名命令；`key` 会补上归属前缀，`expiresSeconds` 缺省取 15 分钟
   * @param signal - 请求生命周期绑定的取消信号，透传给底层 Adapter
   * @returns 预签名 URL 与实际采用的有效期（秒），后者可能与请求值不同
   */
  public presignGet(
    command: PresignObjectCommand,
    signal: AbortSignal
  ): Promise<PresignObjectResult> {
    return this.#presign(command, signal, 'get')
  }

  /**
   * 签发上传预签名 URL。
   *
   * 与 `presignGet` 对称，共用 `#presign`；服务端只产出 URL，不创建对象，实际上传由客户端完成。
   *
   * @param command - 预签名命令；`key` 会补上归属前缀，`expiresSeconds` 缺省取 15 分钟
   * @param signal - 请求生命周期绑定的取消信号，透传给底层 Adapter
   * @returns 预签名 URL 与实际采用的有效期（秒）
   */
  public presignPut(
    command: PresignObjectCommand,
    signal: AbortSignal
  ): Promise<PresignObjectResult> {
    return this.#presign(command, signal, 'put')
  }

  /**
   * 预签名下载与上传的共用实现，归属校验与有效期夹取都在这里完成。
   *
   * 两个公开入口只在签名动作上不同；`expiresSeconds` 回传的是实际采用值而非请求值，
   * 因为缺省与超限都已被本方法改写。
   *
   * @param command - 预签名命令；`key` 在此补上归属前缀，`expiresSeconds` 在此归一化
   * @param signal - 请求生命周期绑定的取消信号，透传给底层适配器
   * @param kind - 签名方向：`get` 签发下载 URL，`put` 签发上传 URL
   * @returns 预签名 URL 与实际采用的有效期（秒）
   */
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

/**
 * 从文件名提取可安全拼进对象 key 的扩展名，不满足约束时返回空串。
 *
 * 白名单取向：只接受小写字母数字组成的短扩展名（不超过 16 字符），其余一律省略 ——
 * 文件名不可信，宽松拼接可能把路径分隔符或超长串带进 key。反斜杠先归一成斜杠再取 basename，
 * 以兼容 Windows 客户端提交的路径。
 *
 * @param filename - 客户端提供的原始文件名
 * @returns 形如 `.png` 的扩展名；不合法时为空串
 */
function safeUploadExtension(filename: string): string {
  const normalized = filename.replaceAll('\\', '/')
  const extension = posix.extname(posix.basename(normalized)).toLowerCase()
  return extension.length <= 16 && /^\.[a-z0-9]+$/u.test(extension) ? extension : ''
}

/**
 * 校验对象 key 的合法性与归属，返回归一化后的 key，越权或非法即抛错。
 *
 * 先做形态校验（非空、已归一化、不含反斜杠），把含 `..`、重复斜杠或反斜杠的 key 判为非法入参，
 * 防止路径穿越；再校验归属前缀，越权 key 刻意与「不存在」返回同一语义，避免泄漏他人对象的存在性。
 *
 * @param userId - 当前归属用户 ID，来自 Principal
 * @param rawKey - 请求指定的对象 key 原文，未经验证
 * @returns 通过校验的 key，已去掉首部多余斜杠
 */
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

/**
 * 归一化预签名有效期：未指定或非正数取默认 15 分钟，超上限则拒绝。
 *
 * 与上传时长的「静默回退」取向不同，超上限刻意抛 INVALID_INPUT 而非夹取：
 * 调用方若请求了过长的有效期，静默缩短会使其误判 URL 的可用窗口。
 *
 * @param seconds - 调用方请求的有效期（秒），可能缺省
 * @returns 实际采用的有效期（秒），落在 1..3600 内
 */
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
