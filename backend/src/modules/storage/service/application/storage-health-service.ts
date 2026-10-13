import type { ObjectStorage } from '../object-storage/port/object-storage.js'
import type { StorageHealthPort } from './port/storage-health.port.js'

/** 通过 Module 私有 ObjectStorage 验证对象存储连通性。 */
export class StorageHealthService implements StorageHealthPort {
  /** 模块私有的对象存储适配器，构造时注入；探活只读它，不转移其所有权。 */
  readonly #storage: ObjectStorage

  public constructor(storage: ObjectStorage) {
    this.#storage = storage
  }

  /**
   * 探活对象存储：以一个固定哨兵 key 触发一次 stat，连通即可，不关心对象是否存在。
   *
   * 只有底层抛错（网络、凭据或服务不可用）才算失败，`stat` 返回 `undefined` 视为连通；
   * 探针不产生任何写入副作用，可被健康检查反复调用。
   *
   * @param signal - 由健康检查调用方提供的取消信号；超时或进程关停时中断探测
   */
  public async check(signal: AbortSignal): Promise<void> {
    await this.#storage.stat('.health-check', signal)
  }
}
